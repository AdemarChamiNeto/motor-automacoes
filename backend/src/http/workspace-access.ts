import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { asUser } from "../db/pool.js";
import { forbidden, notFound } from "./errors.js";

export type Role = "viewer" | "editor" | "owner";
const RANK: Record<Role, number> = { viewer: 0, editor: 1, owner: 2 };

export const uuid = z.string().uuid();

/**
 * Carrega o papel do usuário no workspace da URL. Quem não é membro recebe 404 (não 403): não
 * revela que o workspace existe. A checagem de papel aqui dá a mensagem certa; o RLS do banco
 * continua sendo a garantia, mesmo se uma rota esquecer de chamar `need`.
 */
export async function loadWorkspace(req: Request, res: Response, next: NextFunction) {
  const ws = uuid.safeParse(req.params.ws);
  if (!ws.success) throw notFound("Workspace não encontrado");
  const role = await asUser(res.locals.userId, async (c) =>
    (await c.query<{ role: Role | null }>("SELECT my_role($1) AS role", [ws.data])).rows[0].role,
  );
  if (!role) throw notFound("Workspace não encontrado");
  res.locals.workspaceId = ws.data;
  res.locals.role = role;
  next();
}

export const need = (min: Role) => (_req: Request, res: Response, next: NextFunction) => {
  if (RANK[res.locals.role as Role] < RANK[min]) {
    throw forbidden(min === "owner" ? "Só o owner do workspace pode fazer isso" : "Leitores não podem alterar o workspace");
  }
  next();
};

/** id da URL que precisa ser UUID; senão, 404 (e não um erro de tipo do Postgres). */
export function idParam(req: Request, name: string, what = "Não encontrado"): string {
  const r = uuid.safeParse(req.params[name]);
  if (!r.success) throw notFound(what);
  return r.data;
}
