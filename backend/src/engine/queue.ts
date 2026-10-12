import type { Db } from "../db/pool.js";
import { asSystem } from "../db/pool.js";
import { nextRun } from "../domain/schedule.js";

/**
 * A fila é a própria tabela `executions`. Enfileirar = INSERT na mesma transação que valida o
 * pedido: não existe "gravou no banco mas o job se perdeu no Redis".
 */

/** Cota por workspace: a demo é pública e cada execução faz chamadas de verdade a partir do nosso servidor. */
export const DAILY_EXECUTION_LIMIT = Number(process.env.DAILY_EXECUTION_LIMIT ?? 500);
/** Quantas vezes um worker pode pegar a mesma execução (retries + quedas) antes de desistir. */
export const MAX_CLAIMS = 20;
/** Histórico guardado por 30 dias. */
export const RETENTION_DAYS = 30;

export class QuotaError extends Error {
  constructor() {
    super(`limite de ${DAILY_EXECUTION_LIMIT} execuções por dia neste workspace`);
    this.name = "QuotaError";
  }
}

export type EnqueueArgs = {
  workspaceId: string;
  workflowId: string;
  versionId: string;
  trigger: "webhook" | "schedule" | "manual";
  input: unknown;
  idempotencyKey?: string | null;
  createdBy?: string | null;
};

/**
 * Cria a execução na fila. Reenvio com a mesma chave de idempotência devolve a execução que já
 * existe (duplicate = true) em vez de rodar de novo.
 */
export async function enqueue(c: Db, a: EnqueueArgs): Promise<{ id: string; duplicate: boolean }> {
  if (a.idempotencyKey) {
    const existing = await c.query<{ id: string }>(
      "SELECT id FROM executions WHERE workflow_id = $1 AND idempotency_key = $2",
      [a.workflowId, a.idempotencyKey],
    );
    if (existing.rows[0]) return { id: existing.rows[0].id, duplicate: true };
  }
  // Trava por workspace até o fim da transação: dois webhooks ao mesmo tempo não passam juntos da cota.
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`quota:${a.workspaceId}`]);
  const { rows: [{ n }] } = await c.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM executions WHERE workspace_id = $1 AND created_at >= date_trunc('day', now())",
    [a.workspaceId],
  );
  if (n >= DAILY_EXECUTION_LIMIT) throw new QuotaError();

  const ins = await c.query<{ id: string }>(
    `INSERT INTO executions (workspace_id, workflow_id, version_id, trigger, input, idempotency_key, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (workflow_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
     RETURNING id`,
    [a.workspaceId, a.workflowId, a.versionId, a.trigger, JSON.stringify(a.input ?? {}), a.idempotencyKey ?? null, a.createdBy ?? null],
  );
  if (ins.rows[0]) return { id: ins.rows[0].id, duplicate: false };
  // outro pedido com a mesma chave ganhou a corrida entre o SELECT e o INSERT
  const again = await c.query<{ id: string }>(
    "SELECT id FROM executions WHERE workflow_id = $1 AND idempotency_key = $2",
    [a.workflowId, a.idempotencyKey],
  );
  return { id: again.rows[0].id, duplicate: true };
}

export type ClaimedExecution = {
  id: string;
  workspace_id: string;
  workflow_id: string;
  version_id: string;
  trigger: string;
  input: unknown;
  attempt: number;
  started_at: Date;
};

/**
 * Pega a próxima execução da fila. FOR UPDATE SKIP LOCKED: vários workers (ou várias instâncias)
 * consultam ao mesmo tempo e cada um pula as linhas que outro já está pegando, sem esperar e sem
 * duas pegarem a mesma. A posse vale até locked_until; o worker renova a cada passo.
 */
export function claimNext(workerId: string, leaseMs: number): Promise<ClaimedExecution | null> {
  return asSystem(async (c) => {
    const { rows } = await c.query<ClaimedExecution>(
      `UPDATE executions e
          SET status = 'running', locked_by = $1, locked_until = now() + $2 * interval '1 millisecond',
              started_at = COALESCE(e.started_at, now()), attempt = e.attempt + 1
        WHERE e.id = (
          SELECT id FROM executions
           WHERE status = 'queued' AND run_at <= now()
           ORDER BY run_at
           LIMIT 1
           FOR UPDATE SKIP LOCKED
        )
        RETURNING e.id, e.workspace_id, e.workflow_id, e.version_id, e.trigger, e.input, e.attempt, e.started_at`,
      [workerId, leaseMs],
    );
    return rows[0] ?? null;
  });
}

/**
 * Recupera execuções de worker que morreu (deploy, queda, processo travado): lease vencido volta
 * para a fila. Quem passou do limite de tentativas vira falha, para não ficar em loop para sempre.
 */
export function recoverExpiredLeases(): Promise<{ requeued: number; failed: number }> {
  return asSystem(async (c) => {
    const failed = await c.query(
      `UPDATE executions SET status = 'failed', finished_at = now(), locked_by = NULL, locked_until = NULL,
              error = 'o processamento foi interrompido vezes demais'
        WHERE status = 'running' AND locked_until < now() AND attempt >= $1`,
      [MAX_CLAIMS],
    );
    const requeued = await c.query(
      `UPDATE executions SET status = 'queued', run_at = now(), locked_by = NULL, locked_until = NULL
        WHERE status = 'running' AND locked_until < now()`,
    );
    return { requeued: requeued.rowCount ?? 0, failed: failed.rowCount ?? 0 };
  });
}

/**
 * Agendador: cria as execuções dos agendamentos vencidos. Execução perdida (servidor dormindo no
 * plano grátis) roda UMA vez quando ele acorda, não N vezes: next_run_at pula para a próxima
 * depois de agora. A chave de idempotência "schedule:<horário>" impede duas instâncias de
 * criarem a mesma execução.
 */
export function runDueSchedules(now: () => Date = () => new Date()): Promise<{ enqueued: number; skipped: number }> {
  return asSystem(async (c) => {
    const { rows } = await c.query<{
      id: string; workspace_id: string; workflow_id: string; cron: string; timezone: string;
      next_run_at: Date; published_version_id: string;
    }>(
      `SELECT t.id, t.workspace_id, t.workflow_id, t.cron, t.timezone, t.next_run_at, w.published_version_id
         FROM workflow_triggers t
         JOIN workflows w ON w.id = t.workflow_id
         JOIN workspaces ws ON ws.id = t.workspace_id
        WHERE t.kind = 'schedule' AND t.next_run_at <= now()
          AND w.is_active AND w.deleted_at IS NULL AND ws.deleted_at IS NULL
        ORDER BY t.next_run_at
        LIMIT 50
        FOR UPDATE OF t SKIP LOCKED`,
    );
    let enqueued = 0, skipped = 0;
    for (const t of rows) {
      try {
        const r = await enqueue(c, {
          workspaceId: t.workspace_id,
          workflowId: t.workflow_id,
          versionId: t.published_version_id,
          trigger: "schedule",
          input: { scheduledFor: t.next_run_at.toISOString() },
          idempotencyKey: `schedule:${t.next_run_at.toISOString()}`,
        });
        if (!r.duplicate) enqueued++;
      } catch (err) {
        if (!(err instanceof QuotaError)) throw err;
        skipped++; // cota estourada: pula este horário, não acumula
      }
      const base = now() > t.next_run_at ? now() : t.next_run_at;
      await c.query("UPDATE workflow_triggers SET next_run_at = $2 WHERE id = $1", [t.id, nextRun(t.cron, t.timezone, base)]);
    }
    return { enqueued, skipped };
  });
}

/** Apaga o histórico antigo em lotes (sem travar a tabela inteira) e convites vencidos há muito tempo. */
export function cleanup(): Promise<{ executions: number; invites: number }> {
  return asSystem(async (c) => {
    let executions = 0;
    for (;;) {
      const r = await c.query(
        `DELETE FROM executions WHERE id IN (
           SELECT id FROM executions
            WHERE created_at < now() - $1 * interval '1 day' AND status IN ('succeeded', 'failed', 'canceled')
            LIMIT 1000)`,
        [RETENTION_DAYS],
      );
      executions += r.rowCount ?? 0;
      if ((r.rowCount ?? 0) < 1000) break;
    }
    const inv = await c.query(
      "DELETE FROM workspace_invites WHERE accepted_at IS NULL AND expires_at < now() - $1 * interval '1 day'",
      [RETENTION_DAYS],
    );
    return { executions, invites: inv.rowCount ?? 0 };
  });
}
