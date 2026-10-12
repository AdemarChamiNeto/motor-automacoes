import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { PG, pgCode } from "../db/pool.js";
import { QuotaError } from "../engine/queue.js";

/**
 * Formato padrão de erro: { error, details? }.
 * 4xx = falha de quem chamou (mensagem clara do que corrigir); 5xx = nossa (mensagem genérica +
 * id para achar o caso no log; nunca stack trace na resposta).
 */
export class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly details?: unknown, readonly headers?: Record<string, string>) {
    super(message);
    this.name = "HttpError";
  }
}

export const notFound = (what = "Não encontrado") => new HttpError(404, what);
export const forbidden = (msg = "Seu papel neste workspace não permite isso") => new HttpError(403, msg);

/** Valida com zod; erro vira 400 com a lista campo → mensagem. */
export function parse<T>(schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false; error: ZodError } }, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw new HttpError(400, "Dados inválidos", r.error.issues.map((i) => ({ field: i.path.join("."), message: i.message })));
  }
  return r.data;
}

/** Restrições únicas do banco → mensagem para o usuário. */
const UNIQUE_MESSAGES: Record<string, string> = {
  users_email_key: "E-mail já cadastrado",
  workflows_name_key: "Já existe um fluxo com esse nome neste workspace",
  credentials_name_key: "Já existe uma credencial com esse nome neste workspace",
  workspace_members_workspace_id_user_id_key: "Essa pessoa já é membro do workspace",
};

const secondsUntilUtcMidnight = () => {
  const now = new Date();
  return Math.ceil((Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) - now.getTime()) / 1000);
};

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    if (err.headers) res.set(err.headers);
    return void res.status(err.status).json({ error: err.message, ...(err.details ? { details: err.details } : {}) });
  }
  // corpo maior que o limite / JSON quebrado (vindos do express.json)
  const type = (err as { type?: string }).type;
  if (type === "entity.too.large") return void res.status(413).json({ error: "Corpo da requisição grande demais" });
  if (type === "entity.parse.failed") return void res.status(400).json({ error: "JSON inválido" });
  if (err instanceof ZodError) return void res.status(400).json({ error: "Dados inválidos" });
  if (err instanceof QuotaError) {
    res.set("Retry-After", String(secondsUntilUtcMidnight()));
    return void res.status(429).json({ error: err.message });
  }

  const code = pgCode(err);
  if (code === PG.uniqueViolation) {
    const constraint = (err as { constraint?: string }).constraint ?? "";
    return void res.status(409).json({ error: UNIQUE_MESSAGES[constraint] ?? "Registro duplicado" });
  }
  if (code === PG.checkViolation && (err as { hint?: string }).hint === "last_owner") {
    return void res.status(409).json({ error: "O workspace precisa de pelo menos um owner" });
  }
  // o RLS barrou: a rota deixou passar algo que o papel não permite (a checagem do banco é a última linha)
  if (code === PG.insufficientPrivilege) return void res.status(403).json({ error: "Sem permissão" });

  const id = crypto.randomUUID();
  console.error(`[erro ${id}] ${req.method} ${req.path}:`, err);
  const dbDown = ["ECONNREFUSED", "57P01", "57P03", "08006", "08001"].includes(code ?? (err as { code?: string }).code ?? "");
  res.status(dbDown ? 503 : 500).json({ error: dbDown ? "Serviço indisponível, tente de novo em instantes" : "Erro interno", id });
}
