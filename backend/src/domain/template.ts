/**
 * Variáveis nos campos dos nós: {{trigger.body.pedido.valor}}, {{steps.buscar.body.items.0.id}},
 * {{execution.id}}. Só leitura de caminho em objeto: não há expressão nem eval, então um template
 * não executa código.
 */

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;
const ONLY_PLACEHOLDER = /^\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}$/;

export type Context = Record<string, unknown>;

/** Lê "a.b.0.c" no objeto; caminho que não existe devolve undefined (nunca lança). */
export function lookup(ctx: Context, path: string): unknown {
  let cur: unknown = ctx;
  for (const key of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    // só propriedades próprias: "constructor" ou "__proto__" não sobem para o protótipo
    if (!Object.prototype.hasOwnProperty.call(cur, key)) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

const toText = (v: unknown): string => {
  if (v === undefined || v === null) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
};

/** Troca cada {{caminho}} pelo valor em texto. */
export const renderText = (tpl: string, ctx: Context): string => tpl.replace(PLACEHOLDER, (_, path: string) => toText(lookup(ctx, path)));

/**
 * Se o texto é só uma variável ("{{trigger.body.valor}}"), devolve o valor com o tipo original
 * (número continua número). Senão, o texto montado.
 */
export function renderValue(tpl: string, ctx: Context): unknown {
  const m = ONLY_PLACEHOLDER.exec(tpl);
  return m ? lookup(ctx, m[1]) : renderText(tpl, ctx);
}

/**
 * Corpo JSON: as variáveis são resolvidas DENTRO das strings da estrutura, depois do parse.
 * Assim um valor com aspas vindo do webhook não quebra (nem injeta campos no) JSON enviado.
 */
export function renderJson(value: unknown, ctx: Context): unknown {
  if (typeof value === "string") return renderValue(value, ctx);
  if (Array.isArray(value)) return value.map((v) => renderJson(v, ctx));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, renderJson(v, ctx)]));
  }
  return value;
}

/** Caminhos usados num texto (o editor mostra quais variáveis o nó espera). */
export const pathsIn = (tpl: string): string[] => [...tpl.matchAll(PLACEHOLDER)].map((m) => m[1]);
