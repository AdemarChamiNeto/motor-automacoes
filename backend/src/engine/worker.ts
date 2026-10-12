import crypto from "node:crypto";
import type { Db } from "../db/pool.js";
import { asSystem } from "../db/pool.js";
import { isTrigger, validateDefinition, type FlowNode } from "../domain/definition.js";
import { StepError, backoffMs } from "../domain/retry.js";
import { decrypt } from "../security/secrets.js";
import { runNode, type CredentialKind, type NodeDeps } from "./nodes.js";
import { claimNext, recoverExpiredLeases, type ClaimedExecution } from "./queue.js";
import { safeHttp, type HttpClient } from "./safe-http.js";

export type Outcome = "succeeded" | "failed" | "requeued" | "lost";

export type WorkerDeps = {
  http: HttpClient;
  now: () => Date;
  /** Espera antes da próxima tentativa (ms). Os testes passam () => 0. */
  backoff: (failedAttempts: number, retryAfterMs?: number) => number;
};

export const defaultDeps: WorkerDeps = {
  http: safeHttp,
  now: () => new Date(),
  backoff: (n, retryAfter) => backoffMs(n, Math.random, retryAfter),
};

export const LEASE_MS = 60_000;
/** Saída guardada por passo: o histórico não vira depósito de respostas gigantes. */
export const MAX_STORED_BYTES = 64_000;

function forStorage(value: unknown): string | null {
  if (value === undefined) return null;
  const json = JSON.stringify(value);
  if (json.length <= MAX_STORED_BYTES) return json;
  return JSON.stringify({ truncated: true, preview: json.slice(0, MAX_STORED_BYTES) });
}

const maxAttemptsOf = (n: FlowNode) => ("attempts" in n.data ? n.data.attempts : 1);

/**
 * Faz `fn` só se este worker ainda é dono da execução, e renova a posse (heartbeat).
 * Devolve false se perdeu: o lease venceu e outro worker pegou, ou alguém cancelou.
 * Isso é o "fencing": um worker atrasado não grava por cima do trabalho de outro.
 */
async function withLease(execId: string, workerId: string, fn?: (c: Db) => Promise<void>): Promise<boolean> {
  return asSystem(async (c) => {
    const r = await c.query(
      `UPDATE executions SET locked_until = now() + $3 * interval '1 millisecond'
        WHERE id = $1 AND locked_by = $2 AND status = 'running'`,
      [execId, workerId, LEASE_MS],
    );
    if (r.rowCount === 0) return false;
    await fn?.(c);
    return true;
  });
}

type StepRow = { node_id: string; attempt: number; status: "succeeded" | "failed" | "skipped"; output: unknown };

/**
 * Roda uma execução já pega da fila. Passos que já deram certo (numa tentativa anterior) não
 * rodam de novo: a saída salva é reaproveitada. Assim um retry não manda a mesma notificação duas vezes.
 */
export async function processExecution(exec: ClaimedExecution, workerId: string, deps: WorkerDeps): Promise<Outcome> {
  const { version, workflowName, steps } = await asSystem(async (c) => {
    const v = await c.query<{ definition: unknown; name: string }>(
      `SELECT v.definition, w.name FROM workflow_versions v JOIN workflows w ON w.id = v.workflow_id WHERE v.id = $1`,
      [exec.version_id],
    );
    const s = await c.query<StepRow>(
      "SELECT node_id, attempt, status, output FROM execution_steps WHERE execution_id = $1 ORDER BY attempt",
      [exec.id],
    );
    return { version: v.rows[0]?.definition, workflowName: v.rows[0]?.name ?? "", steps: s.rows };
  });

  const finish = (status: "succeeded" | "failed", error: string | null) =>
    withLease(exec.id, workerId, async (c) => {
      await c.query(
        `UPDATE executions SET status = $2, error = $3, finished_at = now(), locked_by = NULL, locked_until = NULL WHERE id = $1`,
        [exec.id, status, error],
      );
    }).then((ok) => (ok ? status : "lost"));

  const valid = validateDefinition(version);
  if (!valid.ok) return finish("failed", "versão do fluxo inválida: " + valid.problems.map((p) => p.message).join("; "));
  const def = valid.definition;
  const byId = new Map(def.nodes.map((n) => [n.id, n]));

  const nodeDeps: NodeDeps = {
    http: deps.http,
    now: deps.now,
    // a credencial tem que ser DESTE workspace (o JSON do fluxo não tem chave estrangeira)
    credential: (id: string, kind: CredentialKind) =>
      asSystem(async (c) => {
        const r = await c.query<{ secret_encrypted: string }>(
          `SELECT secret_encrypted FROM credentials WHERE id = $1 AND workspace_id = $2 AND kind = $3 AND deleted_at IS NULL`,
          [id, exec.workspace_id, kind],
        );
        return r.rows[0] ? decrypt(r.rows[0].secret_encrypted) : null;
      }),
  };

  const ctx: Record<string, unknown> & { steps: Record<string, unknown> } = {
    trigger: exec.input,
    steps: {},
    execution: { id: exec.id, attempt: exec.attempt, startedAt: exec.started_at },
    workflow: { id: exec.workflow_id, name: workflowName },
  };
  /** Nós que terminaram bem nesta execução, com a saída escolhida (só condição tem). */
  const done = new Map<string, { branch?: "true" | "false" }>();

  const insertStep = (node: FlowNode, attempt: number, status: StepRow["status"], input: unknown, output: unknown, error: string | null, startedAt: Date) =>
    withLease(exec.id, workerId, async (c) => {
      await c.query(
        `INSERT INTO execution_steps (workspace_id, execution_id, node_id, node_type, attempt, status, input, output, error, started_at, finished_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (execution_id, node_id, attempt) DO NOTHING`,
        [exec.workspace_id, exec.id, node.id, node.type, attempt, status, forStorage(input), forStorage(output),
         error?.slice(0, 2000) ?? null, startedAt, new Date(Math.max(startedAt.getTime(), deps.now().getTime()))],
      );
    });

  for (const nodeId of valid.order) {
    const node = byId.get(nodeId)!;
    const history = steps.filter((s) => s.node_id === nodeId);
    const previousOk = history.find((s) => s.status === "succeeded");

    if (!isTrigger(node)) {
      const activated = def.edges.some((e) => e.target === nodeId && done.has(e.source) && (!e.sourceHandle || done.get(e.source)!.branch === e.sourceHandle));
      if (!activated) {
        if (!history.length && !(await insertStep(node, 1, "skipped", null, null, null, deps.now()))) return "lost";
        continue;
      }
    }

    if (previousOk) {
      ctx.steps[nodeId] = previousOk.output;
      const result = (previousOk.output as { result?: boolean } | null)?.result;
      done.set(nodeId, { branch: node.type === "condition" ? (result ? "true" : "false") : undefined });
      continue;
    }

    const failedBefore = history.filter((s) => s.status === "failed").length;
    const attempt = failedBefore + 1;
    const startedAt = deps.now();
    try {
      const run = await runNode(node, ctx, nodeDeps, { executionId: exec.id, nodeId });
      if (!(await insertStep(node, attempt, "succeeded", run.input, run.output, null, startedAt))) return "lost";
      ctx.steps[nodeId] = run.output;
      done.set(nodeId, { branch: run.branch });
    } catch (err) {
      const stepErr = err instanceof StepError
        ? err
        : // erro nosso (bug): log com o id para achar o caso; no histórico, mensagem genérica
          (console.error(`[worker] erro inesperado na execução ${exec.id}, nó ${nodeId}:`, err),
           new StepError("erro interno do motor", true));
      if (!(await insertStep(node, attempt, "failed", stepErr.input ?? null, stepErr.output ?? null, stepErr.message, startedAt))) return "lost";

      if (stepErr.retryable && attempt < maxAttemptsOf(node)) {
        const delay = deps.backoff(attempt, stepErr.retryAfterMs);
        const ok = await withLease(exec.id, workerId, async (c) => {
          await c.query(
            `UPDATE executions SET status = 'queued', run_at = now() + $2 * interval '1 millisecond',
                    locked_by = NULL, locked_until = NULL, error = $3 WHERE id = $1`,
            [exec.id, delay, `${stepErr.message} — tentativa ${attempt} de ${maxAttemptsOf(node)}`.slice(0, 2000)],
          );
        });
        return ok ? "requeued" : "lost";
      }
      const why = stepErr.retryable ? ` (desistiu depois de ${attempt} tentativas)` : "";
      return finish("failed", `nó "${nodeId}": ${stepErr.message}${why}`.slice(0, 2000));
    }
  }
  return finish("succeeded", null);
}

/**
 * Laço do worker: N vagas em paralelo, cada uma pega uma execução por vez. Sem trabalho, dorme
 * `pollMs` (ou acorda antes com wake(), chamado quando o próprio processo enfileira algo).
 */
export class Worker {
  readonly id = `w-${process.pid}-${crypto.randomBytes(3).toString("hex")}`;
  private running = false;
  private loops: Promise<void>[] = [];
  private wakers = new Set<() => void>();
  private timers: NodeJS.Timeout[] = [];

  constructor(private deps: WorkerDeps = defaultDeps, private opts = { concurrency: 2, pollMs: 1_000 }) {}

  /** Pega e roda uma execução (null = fila vazia). Os testes usam direto. */
  async runOnce(): Promise<Outcome | null> {
    const exec = await claimNext(this.id, LEASE_MS);
    return exec ? processExecution(exec, this.id, this.deps) : null;
  }

  wake() {
    for (const w of this.wakers) w();
  }

  start() {
    if (this.running) return;
    this.running = true;
    for (let i = 0; i < this.opts.concurrency; i++) this.loops.push(this.loop());
    // recuperação de lease vencido a cada 15 s
    this.timers.push(setInterval(() => void recoverExpiredLeases().catch((e) => console.error("[worker] recover:", e)), 15_000));
  }

  async stop() {
    this.running = false;
    this.timers.forEach(clearInterval);
    this.wake();
    await Promise.all(this.loops);
    this.loops = [];
  }

  private async loop() {
    while (this.running) {
      let outcome: Outcome | null = null;
      try {
        outcome = await this.runOnce();
      } catch (err) {
        console.error("[worker] falha no laço (banco fora?):", err);
      }
      if (outcome === null && this.running) {
        await new Promise<void>((resolve) => {
          const t = setTimeout(done, this.opts.pollMs);
          const self = this;
          function done() {
            clearTimeout(t);
            self.wakers.delete(done);
            resolve();
          }
          this.wakers.add(done);
        });
      }
    }
  }
}
