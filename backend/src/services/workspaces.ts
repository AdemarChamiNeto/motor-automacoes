import type { Db } from "../db/pool.js";
import { HttpError } from "../http/errors.js";
import { SAMPLE_FLOWS } from "./samples.js";
import { publishWorkflow } from "./workflows.js";

export const MAX_OWNED_WORKSPACES = 5;
export const MAX_MEMBERS = 20;

/**
 * Cria o workspace e o primeiro owner na mesma transação (como sistema: antes do INSERT ninguém é
 * membro, então o RLS não teria como autorizar). Com `samples`, já vem com os fluxos de exemplo.
 */
export async function createWorkspaceWithOwner(c: Db, userId: string, name: string, samples = false): Promise<string> {
  // trava por usuário: dois pedidos juntos não passam do limite
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`owned:${userId}`]);
  const { rows: [{ n }] } = await c.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
      WHERE m.user_id = $1 AND m.role = 'owner' AND w.deleted_at IS NULL`,
    [userId],
  );
  if (n >= MAX_OWNED_WORKSPACES) throw new HttpError(409, `Limite de ${MAX_OWNED_WORKSPACES} workspaces criados por conta`);

  const { rows: [ws] } = await c.query<{ id: string }>("INSERT INTO workspaces (name) VALUES ($1) RETURNING id", [name]);
  await c.query("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')", [ws.id, userId]);

  if (samples) {
    for (const s of SAMPLE_FLOWS) {
      const { rows: [wf] } = await c.query<{ id: string }>(
        "INSERT INTO workflows (workspace_id, name, description, draft, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id",
        [ws.id, s.name, s.description, JSON.stringify(s.draft), userId],
      );
      await publishWorkflow(c, ws.id, wf.id, userId);
    }
  }
  return ws.id;
}

/** Entra no workspace pelo convite (como sistema: quem aceita ainda não é membro). */
export async function joinWorkspace(c: Db, inviteId: string, userId: string, role: string, workspaceId: string) {
  const { rows: [{ n }] } = await c.query<{ n: number }>("SELECT count(*)::int AS n FROM workspace_members WHERE workspace_id = $1", [workspaceId]);
  if (n >= MAX_MEMBERS) throw new HttpError(409, `O workspace já tem ${MAX_MEMBERS} membros`);
  await c.query(
    "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT (workspace_id, user_id) DO NOTHING",
    [workspaceId, userId, role],
  );
  await c.query("UPDATE workspace_invites SET accepted_at = now(), accepted_by = $2 WHERE id = $1", [inviteId, userId]);
}
