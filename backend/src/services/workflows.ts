import type { Db } from "../db/pool.js";
import { credentialKindOf, triggerOf, validateDefinition, type Problem } from "../domain/definition.js";
import { nextRun } from "../domain/schedule.js";
import { HttpError, notFound } from "../http/errors.js";
import { randomToken, sha256 } from "../security/secrets.js";
import { envVar } from "../config/env.js";

export const MAX_WORKFLOWS_PER_WORKSPACE = 20;

export const webhookUrl = (token: string) => `${envVar("PUBLIC_URL").replace(/\/$/, "")}/hooks/${token}`;

/**
 * Publica o rascunho como nova versão imutável. Funciona como usuário (RLS: só editor) ou como
 * sistema (fluxos de exemplo no cadastro).
 *
 * - valida o grafo e confere que cada credencial existe NESTE workspace e é do tipo do nó;
 * - numera a versão com o fluxo travado (FOR UPDATE): duas publicações juntas não pegam o mesmo número;
 * - sincroniza os gatilhos: webhook ganha token (devolvido UMA vez; só o hash fica no banco),
 *   agendamento ganha a próxima execução se o fluxo estiver ativo.
 */
export async function publishWorkflow(c: Db, workspaceId: string, workflowId: string, userId: string | null, now = new Date()) {
  const wf = (await c.query<{ draft: unknown; is_active: boolean }>(
    "SELECT draft, is_active FROM workflows WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL FOR UPDATE",
    [workflowId, workspaceId],
  )).rows[0];
  if (!wf) throw notFound("Fluxo não encontrado");

  const valid = validateDefinition(wf.draft);
  if (!valid.ok) throw new HttpError(422, "O fluxo tem problemas", valid.problems);
  const def = valid.definition;

  const used = def.nodes.flatMap((n) => ("credentialId" in n.data && n.data.credentialId ? [{ node: n, id: n.data.credentialId }] : []));
  if (used.length) {
    const found = new Map((await c.query<{ id: string; kind: string }>(
      "SELECT id, kind FROM credentials WHERE workspace_id = $1 AND id = ANY($2::uuid[]) AND deleted_at IS NULL",
      [workspaceId, used.map((u) => u.id)],
    )).rows.map((r) => [r.id, r.kind]));
    const problems: Problem[] = used
      .filter((u) => found.get(u.id) !== credentialKindOf(u.node))
      .map((u) => ({ nodeId: u.node.id, message: found.has(u.id) ? "credencial de outro tipo" : "credencial não existe mais" }));
    if (problems.length) throw new HttpError(422, "O fluxo tem problemas", problems);
  }

  const { rows: [{ next }] } = await c.query<{ next: number }>(
    "SELECT COALESCE(max(version), 0) + 1 AS next FROM workflow_versions WHERE workflow_id = $1",
    [workflowId],
  );
  const { rows: [version] } = await c.query<{ id: string }>(
    "INSERT INTO workflow_versions (workspace_id, workflow_id, version, definition, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id",
    [workspaceId, workflowId, next, JSON.stringify(def), userId],
  );
  await c.query("UPDATE workflows SET published_version_id = $2 WHERE id = $1", [workflowId, version.id]);

  const trigger = triggerOf(def);
  let webhookToken: string | null = null;
  if (trigger.type === "trigger.webhook") {
    const has = await c.query("SELECT 1 FROM workflow_triggers WHERE workflow_id = $1 AND kind = 'webhook'", [workflowId]);
    if (!has.rowCount) {
      webhookToken = randomToken();
      await c.query(
        "INSERT INTO workflow_triggers (workspace_id, workflow_id, kind, webhook_token_hash) VALUES ($1, $2, 'webhook', $3)",
        [workspaceId, workflowId, sha256(webhookToken)],
      );
    }
  } else {
    await c.query("DELETE FROM workflow_triggers WHERE workflow_id = $1 AND kind = 'webhook'", [workflowId]);
  }
  if (trigger.type === "trigger.schedule") {
    const nextAt = wf.is_active ? nextRun(trigger.data.cron, trigger.data.timezone, now) : null;
    await c.query(
      `INSERT INTO workflow_triggers (workspace_id, workflow_id, kind, cron, timezone, next_run_at) VALUES ($1, $2, 'schedule', $3, $4, $5)
       ON CONFLICT (workflow_id, kind) DO UPDATE SET cron = EXCLUDED.cron, timezone = EXCLUDED.timezone, next_run_at = EXCLUDED.next_run_at`,
      [workspaceId, workflowId, trigger.data.cron, trigger.data.timezone, nextAt],
    );
  } else {
    await c.query("DELETE FROM workflow_triggers WHERE workflow_id = $1 AND kind = 'schedule'", [workflowId]);
  }
  return { version: next, versionId: version.id, webhookToken, webhookUrl: webhookToken ? webhookUrl(webhookToken) : null };
}

/** Liga/desliga. Desligado, o webhook responde 404 e o agendamento para de disparar. */
export async function setActive(c: Db, workspaceId: string, workflowId: string, active: boolean, now = new Date()) {
  const wf = (await c.query<{ published_version_id: string | null }>(
    "SELECT published_version_id FROM workflows WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL FOR UPDATE",
    [workflowId, workspaceId],
  )).rows[0];
  if (!wf) throw notFound("Fluxo não encontrado");
  if (active && !wf.published_version_id) throw new HttpError(409, "Publique o fluxo antes de ativar");
  await c.query("UPDATE workflows SET is_active = $2 WHERE id = $1", [workflowId, active]);
  const t = (await c.query<{ id: string; cron: string; timezone: string }>(
    "SELECT id, cron, timezone FROM workflow_triggers WHERE workflow_id = $1 AND kind = 'schedule'",
    [workflowId],
  )).rows[0];
  if (t) {
    await c.query("UPDATE workflow_triggers SET next_run_at = $2 WHERE id = $1", [t.id, active ? nextRun(t.cron, t.timezone, now) : null]);
  }
}

/** Gera outro token do webhook (o antigo para de funcionar na hora). */
export async function rotateWebhook(c: Db, workspaceId: string, workflowId: string) {
  const token = randomToken();
  const r = await c.query(
    "UPDATE workflow_triggers SET webhook_token_hash = $3 WHERE workflow_id = $1 AND workspace_id = $2 AND kind = 'webhook'",
    [workflowId, workspaceId, sha256(token)],
  );
  if (!r.rowCount) throw new HttpError(409, "Este fluxo não tem gatilho de webhook publicado");
  return { webhookUrl: webhookUrl(token) };
}
