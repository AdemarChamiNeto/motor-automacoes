import { Router } from "express";
import { z } from "zod";
import { asUser } from "../../db/pool.js";
import { validateDefinition } from "../../domain/definition.js";
import { enqueue } from "../../engine/queue.js";
import { MAX_WORKFLOWS_PER_WORKSPACE, publishWorkflow, rotateWebhook, setActive } from "../../services/workflows.js";
import { HttpError, notFound, parse } from "../errors.js";
import { idParam, need } from "../workspace-access.js";

const name = z.string().trim().min(1).max(100);
const description = z.string().trim().max(500);
/** Rascunho: só a forma básica aqui; a validação completa (grafo, credenciais) é na publicação. */
const draft = z.object({ nodes: z.array(z.unknown()).max(60), edges: z.array(z.unknown()).max(200) }).passthrough()
  .refine((d) => JSON.stringify(d).length <= 100_000, "rascunho grande demais");

const EMPTY_DRAFT = { nodes: [{ id: "inicio", type: "trigger.manual", position: { x: 0, y: 0 }, data: {} }], edges: [] };
const STATUSES = ["queued", "running", "succeeded", "failed", "canceled"] as const;

/** Problemas do rascunho para o editor mostrar enquanto a pessoa monta (não impedem salvar). */
const problemsOf = (d: unknown) => {
  const v = validateDefinition(d);
  return v.ok ? [] : v.problems;
};

/** /api/workspaces/:ws/workflows */
export function workflowsRouter(onEnqueue: () => void) {
  const r = Router({ mergeParams: true });

  r.get("/", async (_req, res) => {
    const rows = await asUser(res.locals.userId, async (c) => (await c.query(
      `SELECT w.id, w.name, w.description, w.is_active AS "isActive", v.version AS "publishedVersion",
              (SELECT t.kind FROM workflow_triggers t WHERE t.workflow_id = w.id LIMIT 1) AS "triggerKind",
              last.status AS "lastStatus", last.created_at AS "lastRunAt",
              w.updated_at AS "updatedAt"
         FROM workflows w
         LEFT JOIN workflow_versions v ON v.id = w.published_version_id
         LEFT JOIN LATERAL (
           SELECT e.status, e.created_at FROM executions e WHERE e.workflow_id = w.id ORDER BY e.created_at DESC LIMIT 1
         ) last ON true
        WHERE w.workspace_id = $1 AND w.deleted_at IS NULL
        ORDER BY w.name`,
      [res.locals.workspaceId],
    )).rows);
    res.json(rows);
  });

  r.post("/", need("editor"), async (req, res) => {
    const p = parse(z.object({ name, description: description.default(""), draft: draft.optional() }), req.body);
    const row = await asUser(res.locals.userId, async (c) => {
      const { rows: [{ n }] } = await c.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM workflows WHERE workspace_id = $1 AND deleted_at IS NULL", [res.locals.workspaceId]);
      if (n >= MAX_WORKFLOWS_PER_WORKSPACE) throw new HttpError(409, `Limite de ${MAX_WORKFLOWS_PER_WORKSPACE} fluxos por workspace`);
      return (await c.query(
        `INSERT INTO workflows (workspace_id, name, description, draft, created_by) VALUES ($1, $2, $3, $4, app_user_id())
         RETURNING id, name, description, draft`,
        [res.locals.workspaceId, p.name, p.description, JSON.stringify(p.draft ?? EMPTY_DRAFT)],
      )).rows[0];
    });
    res.status(201).json({ ...row, problems: problemsOf(row.draft) });
  });

  const one = Router({ mergeParams: true });
  r.use("/:id", (req, res, next) => {
    res.locals.workflowId = idParam(req, "id", "Fluxo não encontrado");
    next();
  }, one);

  one.get("/", async (_req, res) => {
    const row = await asUser(res.locals.userId, async (c) => (await c.query(
      `SELECT w.id, w.name, w.description, w.draft, w.is_active AS "isActive",
              v.version AS "publishedVersion", v.created_at AS "publishedAt",
              (v.definition IS DISTINCT FROM w.draft) AS "hasUnpublishedChanges",
              EXISTS (SELECT 1 FROM workflow_triggers t WHERE t.workflow_id = w.id AND t.kind = 'webhook') AS "hasWebhook",
              (SELECT t.next_run_at FROM workflow_triggers t WHERE t.workflow_id = w.id AND t.kind = 'schedule') AS "nextRunAt",
              w.created_at AS "createdAt", w.updated_at AS "updatedAt"
         FROM workflows w LEFT JOIN workflow_versions v ON v.id = w.published_version_id
        WHERE w.id = $1 AND w.workspace_id = $2 AND w.deleted_at IS NULL`,
      [res.locals.workflowId, res.locals.workspaceId],
    )).rows[0]);
    if (!row) throw notFound("Fluxo não encontrado");
    res.json({ ...row, problems: problemsOf(row.draft) });
  });

  /** Salvar o rascunho (o que roda continua sendo a versão publicada até publicar de novo). */
  one.patch("/", need("editor"), async (req, res) => {
    const p = parse(z.object({ name: name.optional(), description: description.optional(), draft: draft.optional() }), req.body);
    const row = await asUser(res.locals.userId, async (c) => (await c.query(
      `UPDATE workflows SET name = COALESCE($3, name), description = COALESCE($4, description), draft = COALESCE($5, draft)
        WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL
        RETURNING id, name, description, draft, updated_at AS "updatedAt"`,
      [res.locals.workflowId, res.locals.workspaceId, p.name ?? null, p.description ?? null, p.draft ? JSON.stringify(p.draft) : null],
    )).rows[0]);
    if (!row) throw notFound("Fluxo não encontrado");
    res.json({ ...row, problems: problemsOf(row.draft) });
  });

  one.delete("/", need("editor"), async (_req, res) => {
    const ok = await asUser(res.locals.userId, async (c) => {
      const r2 = await c.query(
        "UPDATE workflows SET deleted_at = now(), is_active = false WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL",
        [res.locals.workflowId, res.locals.workspaceId]);
      await c.query("UPDATE workflow_triggers SET next_run_at = NULL WHERE workflow_id = $1", [res.locals.workflowId]);
      return r2.rowCount === 1;
    });
    if (!ok) throw notFound("Fluxo não encontrado");
    res.status(204).end();
  });

  one.post("/publish", need("editor"), async (_req, res) => {
    const out = await asUser(res.locals.userId, (c) => publishWorkflow(c, res.locals.workspaceId, res.locals.workflowId, res.locals.userId));
    res.json(out);
  });

  one.post("/activate", need("editor"), async (_req, res) => {
    await asUser(res.locals.userId, (c) => setActive(c, res.locals.workspaceId, res.locals.workflowId, true));
    res.json({ isActive: true });
  });

  one.post("/deactivate", need("editor"), async (_req, res) => {
    await asUser(res.locals.userId, (c) => setActive(c, res.locals.workspaceId, res.locals.workflowId, false));
    res.json({ isActive: false });
  });

  one.post("/webhook/rotate", need("editor"), async (_req, res) => {
    res.json(await asUser(res.locals.userId, (c) => rotateWebhook(c, res.locals.workspaceId, res.locals.workflowId)));
  });

  /** "Executar agora": roda a versão publicada com uma entrada de teste (mesmo desligado). */
  one.post("/run", need("editor"), async (req, res) => {
    const p = parse(z.object({ input: z.record(z.string(), z.unknown()).default({}) }).refine((v) => JSON.stringify(v).length <= 100_000, "entrada grande demais"), req.body ?? {});
    const exec = await asUser(res.locals.userId, async (c) => {
      const wf = (await c.query<{ published_version_id: string | null }>(
        "SELECT published_version_id FROM workflows WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL",
        [res.locals.workflowId, res.locals.workspaceId])).rows[0];
      if (!wf) throw notFound("Fluxo não encontrado");
      if (!wf.published_version_id) throw new HttpError(409, "Publique o fluxo antes de executar");
      return enqueue(c, {
        workspaceId: res.locals.workspaceId, workflowId: res.locals.workflowId, versionId: wf.published_version_id,
        trigger: "manual", input: { body: p.input }, createdBy: res.locals.userId,
      });
    });
    onEnqueue();
    res.status(202).json({ executionId: exec.id });
  });

  one.get("/versions", async (_req, res) => {
    const rows = await asUser(res.locals.userId, async (c) => (await c.query(
      `SELECT v.id, v.version, u.name AS "createdBy", v.created_at AS "createdAt"
         FROM workflow_versions v LEFT JOIN users u ON u.id = v.created_by
        WHERE v.workflow_id = $1 AND v.workspace_id = $2 ORDER BY v.version DESC`,
      [res.locals.workflowId, res.locals.workspaceId],
    )).rows);
    res.json(rows);
  });

  /**
   * Histórico com paginação por cursor (created_at, id): página estável mesmo com execuções novas
   * chegando, e usa o índice (workflow_id, created_at DESC).
   */
  one.get("/executions", async (req, res) => {
    const q = parse(z.object({
      status: z.enum(STATUSES).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(20),
      cursor: z.string().regex(/^[0-9T:.\-Z]+_[0-9a-f-]{36}$/, "cursor inválido").optional(),
    }), req.query);
    const [cAt, cId] = q.cursor ? q.cursor.split("_") : [null, null];
    const rows = await asUser(res.locals.userId, async (c) => (await c.query(
      `SELECT e.id, e.status, e.trigger, e.attempt, e.error, v.version, e.created_at AS "createdAt",
              e.started_at AS "startedAt", e.finished_at AS "finishedAt", e.run_at AS "runAt"
         FROM executions e JOIN workflow_versions v ON v.id = e.version_id
        WHERE e.workflow_id = $1 AND e.workspace_id = $2
          AND ($3::execution_status IS NULL OR e.status = $3)
          AND ($4::timestamptz IS NULL OR (e.created_at, e.id) < ($4, $5::uuid))
        ORDER BY e.created_at DESC, e.id DESC
        LIMIT $6`,
      [res.locals.workflowId, res.locals.workspaceId, q.status ?? null, cAt, cId, q.limit + 1],
    )).rows);
    const page = rows.slice(0, q.limit);
    const last = page.at(-1);
    res.json({
      items: page,
      nextCursor: rows.length > q.limit && last ? `${(last.createdAt as Date).toISOString()}_${last.id}` : null,
    });
  });

  one.get("/executions/:execId", async (req, res) => {
    const execId = idParam(req, "execId", "Execução não encontrada");
    const out = await asUser(res.locals.userId, async (c) => {
      const e = (await c.query(
        `SELECT e.id, e.status, e.trigger, e.attempt, e.error, e.input, v.version, v.definition,
                e.created_at AS "createdAt", e.started_at AS "startedAt", e.finished_at AS "finishedAt", e.run_at AS "runAt"
           FROM executions e JOIN workflow_versions v ON v.id = e.version_id
          WHERE e.id = $1 AND e.workflow_id = $2 AND e.workspace_id = $3`,
        [execId, res.locals.workflowId, res.locals.workspaceId])).rows[0];
      if (!e) throw notFound("Execução não encontrada");
      const steps = (await c.query(
        `SELECT node_id AS "nodeId", node_type AS "nodeType", attempt, status, input, output, error,
                started_at AS "startedAt", finished_at AS "finishedAt",
                (extract(epoch FROM finished_at - started_at) * 1000)::int AS "durationMs"
           FROM execution_steps WHERE execution_id = $1 ORDER BY started_at, attempt`,
        [execId])).rows;
      return { ...e, steps };
    });
    res.json(out);
  });

  one.post("/executions/:execId/cancel", need("editor"), async (req, res) => {
    const execId = idParam(req, "execId", "Execução não encontrada");
    const r2 = await asUser(res.locals.userId, (c) => c.query(
      `UPDATE executions SET status = 'canceled', finished_at = now(), locked_by = NULL, locked_until = NULL, error = 'cancelada por um usuário'
        WHERE id = $1 AND workflow_id = $2 AND workspace_id = $3 AND status IN ('queued', 'running')`,
      [execId, res.locals.workflowId, res.locals.workspaceId]));
    if (!r2.rowCount) throw new HttpError(409, "Só dá para cancelar execuções na fila ou rodando");
    res.json({ status: "canceled" });
  });

  return r;
}
