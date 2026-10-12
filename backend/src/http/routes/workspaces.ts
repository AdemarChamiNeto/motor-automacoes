import { Router } from "express";
import { z } from "zod";
import { asSystem, asUser } from "../../db/pool.js";
import { randomToken, sha256 } from "../../security/secrets.js";
import { createWorkspaceWithOwner, joinWorkspace } from "../../services/workspaces.js";
import { envVar } from "../../config/env.js";
import { HttpError, notFound, parse } from "../errors.js";
import type { Limits } from "../limits.js";
import { requireAuth } from "../session.js";
import { idParam, loadWorkspace, need } from "../workspace-access.js";

const INVITE_DAYS = 7;
const name = z.string().trim().min(1).max(80);
const inviteRole = z.enum(["viewer", "editor"]);

/** /api/workspaces: os workspaces do usuário, membros e convites. */
export function workspacesRouter() {
  const r = Router();
  r.use(requireAuth);

  r.get("/", async (_req, res) => {
    const rows = await asUser(res.locals.userId, async (c) => (await c.query(
      `SELECT w.id, w.name, m.role, w.created_at AS "createdAt",
              (SELECT count(*)::int FROM workspace_members x WHERE x.workspace_id = w.id) AS members
         FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id AND m.user_id = app_user_id()
        WHERE w.deleted_at IS NULL ORDER BY w.created_at`,
    )).rows);
    res.json(rows);
  });

  r.post("/", async (req, res) => {
    const p = parse(z.object({ name }), req.body);
    const id = await asSystem((c) => createWorkspaceWithOwner(c, res.locals.userId, p.name));
    res.status(201).json({ id, name: p.name, role: "owner" });
  });

  const ws = Router({ mergeParams: true });
  r.use("/:ws", loadWorkspace, ws);

  ws.get("/", async (_req, res) => {
    const row = await asUser(res.locals.userId, async (c) =>
      (await c.query(`SELECT id, name, created_at AS "createdAt" FROM workspaces WHERE id = $1`, [res.locals.workspaceId])).rows[0]);
    res.json({ ...row, role: res.locals.role });
  });

  ws.patch("/", need("owner"), async (req, res) => {
    const p = parse(z.object({ name }), req.body);
    await asUser(res.locals.userId, (c) => c.query("UPDATE workspaces SET name = $2 WHERE id = $1", [res.locals.workspaceId, p.name]));
    res.json({ id: res.locals.workspaceId, name: p.name });
  });

  /** Apagar = soft delete: some para todos na hora; webhooks e agendamentos param. */
  ws.delete("/", need("owner"), async (_req, res) => {
    await asUser(res.locals.userId, (c) => c.query("UPDATE workspaces SET deleted_at = now() WHERE id = $1", [res.locals.workspaceId]));
    res.status(204).end();
  });

  // ----- membros -----
  ws.get("/members", async (_req, res) => {
    const rows = await asUser(res.locals.userId, async (c) => (await c.query(
      `SELECT u.id, u.name, u.email, m.role, m.created_at AS "joinedAt"
         FROM workspace_members m JOIN users u ON u.id = m.user_id
        WHERE m.workspace_id = $1 ORDER BY m.created_at`,
      [res.locals.workspaceId],
    )).rows);
    res.json(rows);
  });

  ws.patch("/members/:userId", need("owner"), async (req, res) => {
    const userId = idParam(req, "userId", "Membro não encontrado");
    const p = parse(z.object({ role: z.enum(["viewer", "editor", "owner"]) }), req.body);
    const r2 = await asUser(res.locals.userId, (c) =>
      c.query("UPDATE workspace_members SET role = $3 WHERE workspace_id = $1 AND user_id = $2", [res.locals.workspaceId, userId, p.role]));
    if (!r2.rowCount) throw notFound("Membro não encontrado");
    res.json({ id: userId, role: p.role });
  });

  /** Owner remove alguém; qualquer membro remove a si mesmo (sair). O último owner não sai. */
  ws.delete("/members/:userId", async (req, res) => {
    const userId = idParam(req, "userId", "Membro não encontrado");
    if (userId !== res.locals.userId && res.locals.role !== "owner") throw new HttpError(403, "Só o owner remove outros membros");
    const r2 = await asUser(res.locals.userId, (c) =>
      c.query("DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2", [res.locals.workspaceId, userId]));
    if (!r2.rowCount) throw notFound("Membro não encontrado");
    res.status(204).end();
  });

  // ----- convites (só owner) -----
  ws.get("/invites", need("owner"), async (_req, res) => {
    const rows = await asUser(res.locals.userId, async (c) => (await c.query(
      `SELECT id, role, email, CASE WHEN email IS NULL THEN 'link' ELSE 'email' END AS kind,
              expires_at AS "expiresAt", created_at AS "createdAt"
         FROM workspace_invites
        WHERE workspace_id = $1 AND accepted_at IS NULL AND deleted_at IS NULL AND expires_at > now()
        ORDER BY created_at DESC`,
      [res.locals.workspaceId],
    )).rows);
    res.json(rows);
  });

  /**
   * Convite por link: o token aparece só nesta resposta (no banco fica o hash).
   * Convite por e-mail: fica pendente até a pessoa entrar com esse e-mail. A resposta é sempre a
   * mesma, exista conta ou não: o convite não serve para descobrir quem está cadastrado.
   */
  ws.post("/invites", need("owner"), async (req, res) => {
    const p = parse(z.object({ role: inviteRole, email: z.string().trim().toLowerCase().email().max(254).optional() }), req.body);
    if (p.email) {
      await asUser(res.locals.userId, async (c) => {
        // convite vencido para o mesmo e-mail ainda ocupa o índice de "pendente": sai da frente
        await c.query(
          `UPDATE workspace_invites SET deleted_at = now()
            WHERE workspace_id = $1 AND email = $2 AND accepted_at IS NULL AND deleted_at IS NULL AND expires_at <= now()`,
          [res.locals.workspaceId, p.email],
        );
        await c.query(
          `INSERT INTO workspace_invites (workspace_id, role, email, invited_by, expires_at)
           VALUES ($1, $2, $3, app_user_id(), now() + $4 * interval '1 day')
           ON CONFLICT (email, workspace_id) WHERE email IS NOT NULL AND accepted_at IS NULL AND deleted_at IS NULL DO NOTHING`,
          [res.locals.workspaceId, p.role, p.email, INVITE_DAYS],
        );
      });
      return void res.status(201).json({ kind: "email", email: p.email, role: p.role, message: "Se a pessoa já tiver conta, o convite aparece quando ela entrar; senão, quando se cadastrar com esse e-mail." });
    }
    const token = randomToken();
    const { rows: [inv] } = await asUser(res.locals.userId, (c) => c.query<{ id: string; expires_at: Date }>(
      `INSERT INTO workspace_invites (workspace_id, role, token_hash, invited_by, expires_at)
       VALUES ($1, $2, $3, app_user_id(), now() + $4 * interval '1 day') RETURNING id, expires_at`,
      [res.locals.workspaceId, p.role, sha256(token), INVITE_DAYS],
    ));
    res.status(201).json({
      kind: "link", id: inv.id, role: p.role, expiresAt: inv.expires_at,
      link: `${envVar("PUBLIC_URL").replace(/\/$/, "")}/convite#${token}`, // no fragmento: não vai para logs de servidor nem Referer
    });
  });

  ws.delete("/invites/:id", need("owner"), async (req, res) => {
    const id = idParam(req, "id", "Convite não encontrado");
    const r2 = await asUser(res.locals.userId, (c) => c.query(
      "UPDATE workspace_invites SET deleted_at = now() WHERE id = $1 AND workspace_id = $2 AND accepted_at IS NULL AND deleted_at IS NULL",
      [id, res.locals.workspaceId],
    ));
    if (!r2.rowCount) throw notFound("Convite não encontrado");
    res.status(204).end();
  });

  return r;
}

/** /api/invites: convites recebidos (por e-mail) e aceitar pelo link. */
export function invitesRouter(l: Limits) {
  const r = Router();
  r.use(requireAuth);

  // nome do workspace vem pelo sistema: quem foi convidado ainda não é membro, e o RLS esconderia.
  // O filtro pelo e-mail do próprio usuário é o que isola aqui.
  r.get("/", async (_req, res) => {
    const rows = await asSystem(async (c) => (await c.query(
      `SELECT i.id, i.role, w.name AS workspace, u.name AS "invitedBy", i.expires_at AS "expiresAt"
         FROM workspace_invites i
         JOIN users me ON me.id = $1 AND i.email = me.email
         JOIN workspaces w ON w.id = i.workspace_id AND w.deleted_at IS NULL
         LEFT JOIN users u ON u.id = i.invited_by
        WHERE i.accepted_at IS NULL AND i.deleted_at IS NULL AND i.expires_at > now()
          AND NOT EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace_id = i.workspace_id AND m.user_id = $1)
        ORDER BY i.created_at`,
      [res.locals.userId],
    )).rows);
    res.json(rows);
  });

  r.post("/:id/accept", l.twoFactor, async (req, res) => {
    const id = idParam(req, "id", "Convite não encontrado");
    const ws = await asSystem(async (c) => {
      const inv = (await c.query<{ id: string; workspace_id: string; role: string }>(
        `SELECT i.id, i.workspace_id, i.role FROM workspace_invites i
           JOIN users me ON me.id = $2 AND i.email = me.email
           JOIN workspaces w ON w.id = i.workspace_id AND w.deleted_at IS NULL
          WHERE i.id = $1 AND i.accepted_at IS NULL AND i.deleted_at IS NULL AND i.expires_at > now()
          FOR UPDATE OF i`,
        [id, res.locals.userId],
      )).rows[0];
      if (!inv) throw notFound("Convite não encontrado ou vencido");
      await joinWorkspace(c, inv.id, res.locals.userId, inv.role, inv.workspace_id);
      return inv.workspace_id;
    });
    res.json({ workspaceId: ws });
  });

  r.post("/accept-link", l.twoFactor, async (req, res) => {
    const p = parse(z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/, "link de convite inválido") }), req.body);
    const ws = await asSystem(async (c) => {
      const inv = (await c.query<{ id: string; workspace_id: string; role: string }>(
        `SELECT i.id, i.workspace_id, i.role FROM workspace_invites i
           JOIN workspaces w ON w.id = i.workspace_id AND w.deleted_at IS NULL
          WHERE i.token_hash = $1 AND i.accepted_at IS NULL AND i.deleted_at IS NULL AND i.expires_at > now()
          FOR UPDATE OF i`,
        [sha256(p.token)],
      )).rows[0];
      if (!inv) throw notFound("Convite não encontrado, já usado ou vencido");
      await joinWorkspace(c, inv.id, res.locals.userId, inv.role, inv.workspace_id);
      return inv.workspace_id;
    });
    res.json({ workspaceId: ws });
  });

  return r;
}
