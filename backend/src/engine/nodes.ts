import { evaluate } from "../domain/condition.js";
import { DEFAULT_MODEL, type FlowNode } from "../domain/definition.js";
import { StepError, parseRetryAfter } from "../domain/retry.js";
import { renderJson, renderText, renderValue, type Context } from "../domain/template.js";
import { aiRequest, buildPrompt, googleRetryDelayMs, matchCategory, parseReply, providerMessage } from "./ai.js";
import { HttpFailure, type HttpClient, type HttpResponse } from "./safe-http.js";

export type CredentialKind = "discord_webhook" | "slack_webhook" | "telegram_bot" | "http_header" | "anthropic_key" | "gemini_key";

export type NodeDeps = {
  http: HttpClient;
  /** Segredo já decifrado, ou null se a credencial não existe mais neste workspace (ou é de outro tipo). */
  credential: (id: string, kind: CredentialKind) => Promise<string | null>;
  now: () => Date;
};

export type NodeRun = {
  /** O que o nó recebeu, já resolvido e com segredos mascarados (vai para o histórico). */
  input: unknown;
  output: unknown;
  /** Só na condição: qual saída seguir. */
  branch?: "true" | "false";
};

export type RunMeta = { executionId: string; nodeId: string };

const MASK = "••••••";

/** Mostra só origem + caminho: query string pode ter token. */
function safeUrlForLog(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname}${u.search ? "?…" : ""}`;
  } catch {
    return "(URL inválida)";
  }
}

/** Converte falha de transporte e status HTTP em StepError, decidindo de quem é a falha. */
async function call(deps: NodeDeps, req: Parameters<HttpClient>[0], label: string): Promise<HttpResponse> {
  let res: HttpResponse;
  try {
    res = await deps.http(req);
  } catch (err) {
    if (err instanceof HttpFailure) {
      // timeout e rede: problema do outro lado ou do caminho → tenta de novo.
      // bloqueado, inválido, grande demais: problema da configuração → repetir não muda nada.
      const retryable = err.kind === "timeout" || err.kind === "network";
      throw new StepError(`${label}: ${err.message}`, retryable);
    }
    throw err;
  }
  if (res.status >= 200 && res.status < 300) return res;
  const output = { status: res.status, body: res.body };
  if (res.status === 429 || res.status >= 500) {
    const telegramWait = (res.body as { parameters?: { retry_after?: number } } | null)?.parameters?.retry_after;
    const retryAfter = parseRetryAfter(res.headers["retry-after"] ?? null, deps.now())
      ?? (telegramWait ? telegramWait * 1000 : undefined)
      ?? googleRetryDelayMs(res.body);
    throw new StepError(`${label}: HTTP ${res.status} (serviço externo; vai tentar de novo)`, true, retryAfter, output);
  }
  throw new StepError(`${label}: HTTP ${res.status} (confira a configuração do nó)`, false, undefined, output);
}

async function needCredential(deps: NodeDeps, id: string, kind: CredentialKind): Promise<string> {
  const secret = await deps.credential(id, kind);
  if (secret === null) throw new StepError("credencial apagada ou de outro tipo: escolha outra no nó", false);
  return secret;
}

export async function runNode(node: FlowNode, ctx: Context, deps: NodeDeps, meta: RunMeta): Promise<NodeRun> {
  const idempotencyKey = `${meta.executionId}:${meta.nodeId}`;

  switch (node.type) {
    case "trigger.webhook":
    case "trigger.manual":
    case "trigger.schedule":
      return { input: null, output: ctx.trigger };

    case "condition": {
      const left = renderValue(node.data.left, ctx);
      const right = renderText(node.data.right, ctx);
      const result = evaluate(left, node.data.operator, right);
      return { input: { left, operator: node.data.operator, right }, output: { result }, branch: result ? "true" : "false" };
    }

    case "http": {
      const d = node.data;
      const url = renderText(d.url, ctx);
      const headers: Record<string, string> = { "idempotency-key": idempotencyKey };
      const shownHeaders: Record<string, string> = {};
      for (const h of d.headers) {
        headers[h.name.toLowerCase()] = renderText(h.value, ctx);
        shownHeaders[h.name] = /^(authorization|x-api-key|cookie)$/i.test(h.name) ? MASK : headers[h.name.toLowerCase()];
      }
      if (d.credentialId) {
        const secret = await needCredential(deps, d.credentialId, "http_header");
        const { name, value } = JSON.parse(secret) as { name: string; value: string };
        headers[name.toLowerCase()] = value;
        shownHeaders[name] = MASK;
      }
      let body: string | undefined;
      if (d.body !== undefined && d.method !== "GET" && d.method !== "DELETE") {
        body = JSON.stringify(renderJson(d.body, ctx));
        headers["content-type"] ??= "application/json";
      }
      const input = { method: d.method, url: safeUrlForLog(url), headers: shownHeaders, body: body ? JSON.parse(body) : undefined };
      try {
        const res = await call(deps, { method: d.method, url, headers, body, timeoutMs: d.timeoutMs }, `${d.method} ${safeUrlForLog(url)}`);
        return { input, output: { status: res.status, headers: res.headers, body: res.body } };
      } catch (err) {
        if (err instanceof StepError) throw Object.assign(err, { input });
        throw err;
      }
    }

    case "ai": {
      const d = node.data;
      const model = d.model || DEFAULT_MODEL[d.provider];
      const label = d.provider === "anthropic" ? "Claude" : "Gemini";
      // só os dados aceitam {{variáveis}}: as instruções ficam fixas (ver ai.ts)
      const prompt = buildPrompt(d.instructions, renderText(d.input, ctx), d.mode, d.categories);
      const input = {
        provider: d.provider, model, mode: d.mode, instructions: d.instructions, data: prompt.data,
        ...(d.mode === "category" ? { categories: d.categories } : {}),
        ...(prompt.truncated ? { dataTruncated: true } : {}),
      };
      // sem credencial: modo de teste, não chama a IA (a demo pública não gasta a chave de ninguém)
      if (!d.credentialId) {
        return { input, output: { simulated: true, [d.mode === "category" ? "category" : "text"]: null, note: `modo de teste: cadastre uma chave do ${label} para a IA responder` } };
      }
      const key = await needCredential(deps, d.credentialId, d.provider === "anthropic" ? "anthropic_key" : "gemini_key");
      let res: HttpResponse;
      try {
        res = await call(deps, aiRequest({ provider: d.provider, model, prompt, mode: d.mode, categories: d.categories, maxTokens: d.maxTokens, timeoutMs: d.timeoutMs }, key), label);
      } catch (err) {
        if (!(err instanceof StepError)) throw err;
        // o corpo do erro do provedor diz o que houve ("model not found", "invalid x-api-key"); guarda só a mensagem
        const status = (err.output as { status?: number } | undefined)?.status;
        const msg = providerMessage((err.output as { body?: unknown } | undefined)?.body);
        const hint = status === 401 || status === 403 ? " — chave inválida ou sem permissão: confira a credencial" : "";
        throw Object.assign(
          new StepError(`${err.message}${msg ? ` — ${msg}` : ""}${hint}`, err.retryable, err.retryAfterMs, status ? { status, error: msg } : undefined),
          { input },
        );
      }
      const reply = parseReply(d.provider, res.body);
      const usage = reply.usage;
      const fail = (message: string) => Object.assign(new StepError(`${label}: ${message}`, false, undefined, { text: reply.text.slice(0, 500), usage }), { input });
      if (reply.stop === "refusal") throw fail("a IA se recusou a responder (confira as instruções e os dados)");
      if (reply.stop === "empty") throw fail("a resposta veio vazia (o filtro de conteúdo do provedor pode ter barrado)");

      if (d.mode === "category") {
        if (reply.stop === "max_tokens") throw fail("a resposta foi cortada pelo limite de tokens: aumente o limite do nó");
        const category = matchCategory(reply.text, d.categories);
        if (!category) throw fail(`a IA respondeu "${reply.text.slice(0, 80)}", que não está na lista de categorias`);
        return { input, output: { category, model, usage } };
      }
      return { input, output: { text: reply.text, model, usage, ...(reply.stop === "max_tokens" ? { truncated: true } : {}) } };
    }

    case "notify.discord":
    case "notify.slack":
    case "notify.telegram": {
      const message = renderText(node.data.message, ctx);
      const channel = node.type.slice("notify.".length);
      const input = { channel, message, ...(node.type === "notify.telegram" ? { chatId: node.data.chatId } : {}) };
      // sem credencial: modo de teste, a mensagem fica só no histórico (a demo funciona sem configurar nada)
      if (!node.data.credentialId) return { input, output: { simulated: true, message } };

      if (node.type === "notify.telegram") {
        const token = await needCredential(deps, node.data.credentialId, "telegram_bot");
        await call(deps, {
          method: "POST",
          url: `https://api.telegram.org/bot${token}/sendMessage`,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: node.data.chatId, text: message.slice(0, 4096) }),
          timeoutMs: 10_000,
        }, "Telegram");
        return { input, output: { sent: true } };
      }
      const kind = node.type === "notify.discord" ? "discord_webhook" : "slack_webhook";
      const webhookUrl = await needCredential(deps, node.data.credentialId, kind);
      // a mensagem pode carregar texto de fora (webhook, resposta da IA): no Discord, nada de @everyone nem menção
      const payload = node.type === "notify.discord"
        ? { content: message.slice(0, 2000), allowed_mentions: { parse: [] } }
        : { text: message.slice(0, 3000) };
      await call(deps, {
        method: "POST",
        url: webhookUrl,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        timeoutMs: 10_000,
      }, node.type === "notify.discord" ? "Discord" : "Slack");
      return { input, output: { sent: true } };
    }
  }
}
