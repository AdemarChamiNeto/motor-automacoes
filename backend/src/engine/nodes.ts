import { evaluate } from "../domain/condition.js";
import type { FlowNode } from "../domain/definition.js";
import { StepError, parseRetryAfter } from "../domain/retry.js";
import { renderJson, renderText, renderValue, type Context } from "../domain/template.js";
import { HttpFailure, type HttpClient, type HttpResponse } from "./safe-http.js";

export type CredentialKind = "discord_webhook" | "slack_webhook" | "telegram_bot" | "http_header";

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
    const retryAfter = parseRetryAfter(res.headers["retry-after"] ?? null, deps.now()) ?? (telegramWait ? telegramWait * 1000 : undefined);
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
      const payload = node.type === "notify.discord" ? { content: message.slice(0, 2000) } : { text: message.slice(0, 3000) };
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
