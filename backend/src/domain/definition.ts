import { z } from "zod";
import { validateCron } from "./schedule.js";

/**
 * Definição de um fluxo: nós + arestas, o mesmo formato que o React Flow usa no editor.
 * Fica em JSON no banco (rascunho editável e versões publicadas imutáveis).
 */

export const MAX_NODES = 30;
export const MAX_ATTEMPTS = 5;
export const MAX_TIMEOUT_MS = 15_000;

const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "id inválido");
const position = z.object({ x: z.number().finite(), y: z.number().finite() }).default({ x: 0, y: 0 });
/** Texto com {{variáveis}}. Limite de tamanho para ninguém salvar megabytes num nó. */
const template = (max = 2000) => z.string().max(max, `máximo de ${max} caracteres`);
const credentialId = z.string().uuid("credencial inválida").nullable().default(null);
/** Tentativas de cada ação (1 = sem retry). */
const attempts = z.number().int().min(1).max(MAX_ATTEMPTS).default(3);

const triggerWebhook = z.object({ id, type: z.literal("trigger.webhook"), position, data: z.object({}).strict().default({}) });
const triggerManual = z.object({ id, type: z.literal("trigger.manual"), position, data: z.object({}).strict().default({}) });
const triggerSchedule = z.object({
  id,
  type: z.literal("trigger.schedule"),
  position,
  data: z.object({
    cron: z.string().max(100),
    timezone: z.string().max(64).default("America/Sao_Paulo"),
  }),
});

export const OPERATORS = ["eq", "neq", "gt", "gte", "lt", "lte", "contains", "not_contains", "exists", "not_exists"] as const;
export type Operator = (typeof OPERATORS)[number];

const condition = z.object({
  id,
  type: z.literal("condition"),
  position,
  data: z.object({
    left: template(500),
    operator: z.enum(OPERATORS),
    right: template(500).default(""),
  }),
});

export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

/** Corpo JSON com {{variáveis}} nas strings (sem limite de profundidade absurdo: o tamanho é limitado na serialização). */
const jsonValue: z.ZodType<unknown> = z.lazy(() =>
  z.union([z.string().max(2000), z.number().finite(), z.boolean(), z.null(), z.array(jsonValue).max(100), z.record(z.string(), jsonValue)]),
);

const http = z.object({
  id,
  type: z.literal("http"),
  position,
  data: z.object({
    method: z.enum(HTTP_METHODS).default("GET"),
    url: template(2000),
    headers: z
      .array(z.object({ name: z.string().regex(/^[A-Za-z0-9-]{1,64}$/, "nome de cabeçalho inválido"), value: template(1000) }))
      .max(20)
      .default([]),
    body: jsonValue.optional(),
    credentialId, // credencial "http_header" (ex.: Authorization: Bearer ...)
    timeoutMs: z.number().int().min(500).max(MAX_TIMEOUT_MS).default(10_000),
    attempts,
  }),
});

const notifyWebhook = (type: "notify.discord" | "notify.slack") =>
  z.object({
    id,
    type: z.literal(type),
    position,
    data: z.object({ credentialId, message: template(2000), attempts }),
  });

const notifyTelegram = z.object({
  id,
  type: z.literal("notify.telegram"),
  position,
  data: z.object({
    credentialId,
    chatId: z.string().regex(/^-?\d{1,20}$|^@[A-Za-z0-9_]{5,32}$/, "chat_id inválido (número ou @canal)"),
    message: template(4000),
    attempts,
  }),
});

export const AI_PROVIDERS = ["anthropic", "gemini"] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];
/** Modelo usado quando o nó não escolhe um: barato e rápido. (Em 13/10/2026 o gemini-3.5-flash-lite levava ~40 s no plano grátis; o 3.1, ~2 s.) */
export const DEFAULT_MODEL: Record<AiProvider, string> = { anthropic: "claude-haiku-5-5", gemini: "gemini-3.1-flash-lite" };
/** A IA demora mais que uma API comum, mas fica bem abaixo do lease do worker (60 s). */
export const MAX_AI_TIMEOUT_MS = 30_000;

const category = z.string().trim().min(1).max(40);

const ai = z.object({
  id,
  type: z.literal("ai"),
  position,
  data: z
    .object({
      provider: z.enum(AI_PROVIDERS).default("gemini"),
      /** Vazio = DEFAULT_MODEL do provedor. Formato livre (os provedores lançam modelos novos), mas sem espaço nem barra. */
      model: z.string().regex(/^$|^[a-z0-9][a-z0-9.-]{1,63}$/, "nome de modelo inválido").default(""),
      credentialId,
      mode: z.enum(["text", "category"]).default("text"),
      /** O que a IA deve fazer. Texto fixo de quem monta o fluxo: NÃO aceita {{variáveis}} (ver nodes.ts). */
      instructions: z.string().trim().min(1, "escreva o que a IA deve fazer").max(2000),
      /** Os dados que a IA analisa (ex.: {{trigger.body.mensagem}}). */
      input: template(4000),
      categories: z.array(category).max(10).default([]),
      maxTokens: z.number().int().min(50).max(1000).default(400),
      timeoutMs: z.number().int().min(1000).max(MAX_AI_TIMEOUT_MS).default(20_000),
      // cada tentativa é cobrada pelo provedor: padrão menor que o das outras ações
      attempts: attempts.default(2),
    })
    .superRefine((d, ctx) => {
      if (d.mode !== "category") return;
      if (d.categories.length < 2) ctx.addIssue({ code: "custom", path: ["categories"], message: "liste pelo menos 2 categorias" });
      const seen = new Set<string>();
      for (const c of d.categories) {
        if (seen.has(c.toLowerCase())) ctx.addIssue({ code: "custom", path: ["categories"], message: `categoria "${c}" repetida` });
        seen.add(c.toLowerCase());
      }
    }),
});

export const nodeSchema = z.discriminatedUnion("type", [
  triggerWebhook,
  triggerManual,
  triggerSchedule,
  condition,
  http,
  ai,
  notifyWebhook("notify.discord"),
  notifyWebhook("notify.slack"),
  notifyTelegram,
]);

export const edgeSchema = z.object({
  id,
  source: id,
  target: id,
  /** Saída do nó de condição ("true" ou "false"); nos outros nós fica vazio. */
  sourceHandle: z.enum(["true", "false"]).nullable().optional(),
});

export const definitionSchema = z.object({
  nodes: z.array(nodeSchema).min(1).max(MAX_NODES, `máximo de ${MAX_NODES} nós`),
  edges: z.array(edgeSchema).max(MAX_NODES * 3),
});

export type Definition = z.infer<typeof definitionSchema>;
export type FlowNode = z.infer<typeof nodeSchema>;
export type NodeType = FlowNode["type"];
export type Edge = z.infer<typeof edgeSchema>;

export const isTrigger = (n: FlowNode) => n.type.startsWith("trigger.");
/** Tipo de credencial que o nó aceita (no nó de IA, depende do provedor escolhido). */
export function credentialKindOf(n: FlowNode): string | undefined {
  switch (n.type) {
    case "http": return "http_header";
    case "ai": return n.data.provider === "anthropic" ? "anthropic_key" : "gemini_key";
    case "notify.discord": return "discord_webhook";
    case "notify.slack": return "slack_webhook";
    case "notify.telegram": return "telegram_bot";
    default: return undefined;
  }
}

export type Problem = { nodeId?: string; message: string };

export type ValidResult = { ok: true; definition: Definition; order: string[] } | { ok: false; problems: Problem[] };

/**
 * Valida o formato (zod) e o grafo: um gatilho só, arestas que apontam para nós existentes,
 * saídas certas na condição, sem ciclo e sem nó solto. Devolve também a ordem de execução.
 */
export function validateDefinition(raw: unknown): ValidResult {
  const parsed = definitionSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      problems: parsed.error.issues.map((i) => {
        const nodeIndex = i.path[0] === "nodes" && typeof i.path[1] === "number" ? i.path[1] : null;
        const nodeId = nodeIndex !== null ? (raw as { nodes?: { id?: unknown }[] }).nodes?.[nodeIndex]?.id : undefined;
        return { nodeId: typeof nodeId === "string" ? nodeId : undefined, message: `${i.path.join(".")}: ${i.message}` };
      }),
    };
  }
  const def = parsed.data;
  const problems: Problem[] = [];
  const byId = new Map<string, FlowNode>();
  for (const n of def.nodes) {
    if (byId.has(n.id)) problems.push({ nodeId: n.id, message: "id de nó repetido" });
    byId.set(n.id, n);
  }

  const triggers = def.nodes.filter(isTrigger);
  if (triggers.length !== 1) problems.push({ message: "o fluxo precisa de exatamente um gatilho" });

  const edgeIds = new Set<string>();
  const pairs = new Set<string>();
  for (const e of def.edges) {
    if (edgeIds.has(e.id)) problems.push({ message: `aresta ${e.id} repetida` });
    edgeIds.add(e.id);
    const src = byId.get(e.source);
    const dst = byId.get(e.target);
    if (!src || !dst) {
      problems.push({ message: `aresta ${e.id} liga um nó que não existe` });
      continue;
    }
    if (e.source === e.target) problems.push({ nodeId: e.source, message: "nó ligado nele mesmo" });
    if (isTrigger(dst)) problems.push({ nodeId: dst.id, message: "nada pode apontar para o gatilho" });
    if (src.type === "condition" && !e.sourceHandle) problems.push({ nodeId: src.id, message: "ligação da condição sem saída (sim/não)" });
    if (src.type !== "condition" && e.sourceHandle) problems.push({ nodeId: src.id, message: "só a condição tem saídas sim/não" });
    const key = `${e.source}|${e.sourceHandle ?? ""}|${e.target}`;
    if (pairs.has(key)) problems.push({ nodeId: src.id, message: "ligação repetida" });
    pairs.add(key);
  }

  for (const n of def.nodes) {
    if (n.type === "trigger.schedule") {
      const err = validateCron(n.data.cron, n.data.timezone);
      if (err) problems.push({ nodeId: n.id, message: err });
    }
  }
  if (problems.length) return { ok: false, problems };

  // ordem topológica (Kahn): se sobrar nó, há ciclo
  const indegree = new Map(def.nodes.map((n) => [n.id, 0]));
  const out = new Map<string, string[]>(def.nodes.map((n) => [n.id, []]));
  for (const e of def.edges) {
    indegree.set(e.target, indegree.get(e.target)! + 1);
    out.get(e.source)!.push(e.target);
  }
  const queue = def.nodes.filter((n) => indegree.get(n.id) === 0).map((n) => n.id);
  const order: string[] = [];
  while (queue.length) {
    const nid = queue.shift()!;
    order.push(nid);
    for (const t of out.get(nid)!) {
      indegree.set(t, indegree.get(t)! - 1);
      if (indegree.get(t) === 0) queue.push(t);
    }
  }
  if (order.length !== def.nodes.length) {
    const inCycle = def.nodes.filter((n) => !order.includes(n.id)).map((n) => n.id);
    return { ok: false, problems: inCycle.map((nodeId) => ({ nodeId, message: "o fluxo tem um ciclo (loop) passando por este nó" })) };
  }

  // todo nó precisa ser alcançável a partir do gatilho
  const reach = new Set([triggers[0].id]);
  for (const nid of order) if (reach.has(nid)) for (const t of out.get(nid)!) reach.add(t);
  const loose = def.nodes.filter((n) => !reach.has(n.id));
  if (loose.length) return { ok: false, problems: loose.map((n) => ({ nodeId: n.id, message: "nó solto: não está ligado ao gatilho" })) };

  // o gatilho é o único sem entrada; ele vai na frente da ordem
  return { ok: true, definition: def, order };
}

export const triggerOf = (def: Definition) => def.nodes.find(isTrigger)!;
