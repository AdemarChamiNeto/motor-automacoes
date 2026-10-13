import type { CredentialKind, NodeType } from "../api";

export type Group = "trigger" | "logic" | "action" | "ai" | "notify";

export type NodeSpec = {
  label: string;
  group: Group;
  description: string;
  /** Configuração inicial de um nó novo (o servidor completa os padrões que faltarem). */
  defaults: () => Record<string, unknown>;
  credentialKind?: CredentialKind;
};

export const CATALOG: Record<NodeType, NodeSpec> = {
  "trigger.webhook": {
    label: "Webhook", group: "trigger",
    description: "Roda quando um sistema de fora faz POST na URL do fluxo.",
    defaults: () => ({}),
  },
  "trigger.schedule": {
    label: "Agendamento", group: "trigger",
    description: "Roda sozinho no horário do cron (mínimo a cada 5 minutos).",
    defaults: () => ({ cron: "0 9 * * 1-5", timezone: "America/Sao_Paulo" }),
  },
  "trigger.manual": {
    label: "Manual", group: "trigger",
    description: "Roda só pelo botão “Executar agora”.",
    defaults: () => ({}),
  },
  condition: {
    label: "Condição", group: "logic",
    description: "Compara um valor e segue pela saída “sim” ou “não”.",
    defaults: () => ({ left: "{{trigger.body.valor}}", operator: "gt", right: "100" }),
  },
  http: {
    label: "Chamada HTTP", group: "action",
    description: "Chama uma API. A resposta fica disponível para os próximos nós.",
    defaults: () => ({ method: "GET", url: "https://", headers: [], timeoutMs: 10000, attempts: 3, credentialId: null }),
    credentialKind: "http_header",
  },
  ai: {
    label: "IA", group: "ai",
    description: "Pede ao Claude ou ao Gemini para resumir, responder ou classificar um texto. A saída fica para os próximos nós.",
    defaults: () => ({
      provider: "gemini", model: "", credentialId: null, mode: "text",
      instructions: "Resuma o texto em uma frase.", input: "{{trigger.body.texto}}",
      categories: [], maxTokens: 400, timeoutMs: 20000, attempts: 2,
    }),
  },
  "notify.discord": {
    label: "Discord", group: "notify",
    description: "Manda uma mensagem num canal pelo webhook do Discord.",
    defaults: () => ({ message: "", credentialId: null, attempts: 3 }),
    credentialKind: "discord_webhook",
  },
  "notify.slack": {
    label: "Slack", group: "notify",
    description: "Manda uma mensagem num canal pelo webhook do Slack.",
    defaults: () => ({ message: "", credentialId: null, attempts: 3 }),
    credentialKind: "slack_webhook",
  },
  "notify.telegram": {
    label: "Telegram", group: "notify",
    description: "Manda uma mensagem pelo seu bot do Telegram.",
    defaults: () => ({ message: "", chatId: "", credentialId: null, attempts: 3 }),
    credentialKind: "telegram_bot",
  },
};

export const TRIGGER_TYPES: NodeType[] = ["trigger.webhook", "trigger.schedule", "trigger.manual"];
/** O que aparece na paleta para adicionar (o gatilho é único e troca de tipo no painel). */
export const PALETTE: NodeType[] = ["condition", "http", "ai", "notify.discord", "notify.slack", "notify.telegram"];

export const isTrigger = (t: NodeType) => t.startsWith("trigger.");

/** Tipo de credencial do nó; no de IA depende do provedor escolhido (igual ao servidor). */
export const credentialKindOf = (type: NodeType, config: Record<string, unknown>): CredentialKind | undefined =>
  type === "ai" ? (config.provider === "anthropic" ? "anthropic_key" : "gemini_key") : CATALOG[type].credentialKind;

export const AI_PROVIDERS = [
  { value: "gemini", label: "Gemini", defaultModel: "gemini-3.1-flash-lite", models: ["gemini-3.1-flash-lite", "gemini-3.5-flash-lite", "gemini-3.8-flash"] },
  { value: "anthropic", label: "Claude", defaultModel: "claude-haiku-5-5", models: ["claude-haiku-5-5", "claude-sonnet-5-5"] },
] as const;

export const OPERATORS: { value: string; label: string; unary?: boolean }[] = [
  { value: "eq", label: "é igual a" },
  { value: "neq", label: "é diferente de" },
  { value: "gt", label: "é maior que" },
  { value: "gte", label: "é maior ou igual a" },
  { value: "lt", label: "é menor que" },
  { value: "lte", label: "é menor ou igual a" },
  { value: "contains", label: "contém" },
  { value: "not_contains", label: "não contém" },
  { value: "exists", label: "existe", unary: true },
  { value: "not_exists", label: "não existe", unary: true },
];

export const CREDENTIAL_LABEL: Record<CredentialKind, string> = {
  discord_webhook: "Webhook do Discord",
  slack_webhook: "Webhook do Slack",
  telegram_bot: "Bot do Telegram",
  http_header: "Cabeçalho HTTP (token de API)",
  anthropic_key: "Chave do Claude (Anthropic)",
  gemini_key: "Chave do Gemini (Google)",
};
