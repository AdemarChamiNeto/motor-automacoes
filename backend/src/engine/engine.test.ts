import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createPublishedWorkflow, createUser, createWorkspace, owner, resetDb } from "../testing/db.js";

process.env.DAILY_EXECUTION_LIMIT = "5";
const { asSystem, closePool } = await import("../db/pool.js");
const { enqueue, claimNext, recoverExpiredLeases, runDueSchedules, QuotaError } = await import("./queue.js");
const { processExecution, Worker } = await import("./worker.js");
const { HttpFailure } = await import("./safe-http.js");
const { encrypt } = await import("../security/secrets.js");
type HttpRequest = import("./safe-http.js").HttpRequest;
type HttpResponse = import("./safe-http.js").HttpResponse;

/** Faz o papel da internet: respostas roteiradas por URL e registro de cada chamada. */
function fakeHttp(script: Record<string, (HttpResponse | Error)[]>) {
  const calls: HttpRequest[] = [];
  const client = async (req: HttpRequest): Promise<HttpResponse> => {
    calls.push(req);
    const queue = script[req.url] ?? [];
    const next = queue.length > 1 ? queue.shift()! : queue[0];
    if (!next) return { status: 200, headers: {}, body: { ok: true } };
    if (next instanceof Error) throw next;
    return next;
  };
  return { client, calls };
}

const deps = (http: (r: HttpRequest) => Promise<HttpResponse>) => ({ http, now: () => new Date(), backoff: () => 0 });

/** webhook → condição (valor > 100) → [sim] POST na API → Discord ; [não] Slack */
const pedidoFlow = (discordCredential: string | null = null) => ({
  nodes: [
    { id: "gatilho", type: "trigger.webhook", data: {} },
    { id: "grande", type: "condition", data: { left: "{{trigger.body.valor}}", operator: "gt", right: "100" } },
    { id: "registrar", type: "http", data: { method: "POST", url: "https://api.exemplo.com/pedidos", body: { id: "{{trigger.body.id}}", valor: "{{trigger.body.valor}}" }, attempts: 3 } },
    { id: "avisar", type: "notify.discord", data: { credentialId: discordCredential, message: "Pedido {{trigger.body.id}} registrado: {{steps.registrar.body.protocolo}}" } },
    { id: "pequeno", type: "notify.slack", data: { message: "Pedido pequeno {{trigger.body.id}}" } },
  ],
  edges: [
    { id: "e1", source: "gatilho", target: "grande" },
    { id: "e2", source: "grande", target: "registrar", sourceHandle: "true" },
    { id: "e3", source: "registrar", target: "avisar" },
    { id: "e4", source: "grande", target: "pequeno", sourceHandle: "false" },
  ],
});

let ws: string;
beforeEach(async () => {
  await resetDb();
  ws = await createWorkspace("Loja", [[await createUser("Ana"), "owner"]]);
});
after(closePool);

const enqueueWebhook = (workflowId: string, versionId: string, body: unknown, key?: string) =>
  asSystem((c) => enqueue(c, { workspaceId: ws, workflowId, versionId, trigger: "webhook", input: { body }, idempotencyKey: key }));

async function steps(executionId: string) {
  const { rows } = await owner().query(
    "SELECT node_id, attempt, status, input, output, error FROM execution_steps WHERE execution_id = $1 ORDER BY started_at, attempt",
    [executionId],
  );
  return rows;
}
const execution = async (id: string) => (await owner().query("SELECT * FROM executions WHERE id = $1", [id])).rows[0];

test("caminho feliz: condição verdadeira chama a API, usa a resposta na notificação e pula o outro ramo", async () => {
  const { workflowId, versionId } = await createPublishedWorkflow(ws, pedidoFlow());
  const { id } = await enqueueWebhook(workflowId, versionId, { id: "P-1", valor: 250 });
  const http = fakeHttp({ "https://api.exemplo.com/pedidos": [{ status: 201, headers: {}, body: { protocolo: "ABC-9" } }] });

  const worker = new Worker(deps(http.client));
  assert.equal(await worker.runOnce(), "succeeded");
  assert.equal(await worker.runOnce(), null); // fila vazia

  const e = await execution(id);
  assert.equal(e.status, "succeeded");
  assert.ok(e.finished_at && !e.locked_by);
  const s = await steps(id);
  assert.deepEqual(s.map((x) => [x.node_id, x.status]).sort(), [
    ["avisar", "succeeded"], ["gatilho", "succeeded"], ["grande", "succeeded"], ["pequeno", "skipped"], ["registrar", "succeeded"],
  ]);
  // corpo JSON montado com o tipo certo (valor continua número) e chave de idempotência por nó
  assert.deepEqual(JSON.parse(http.calls[0].body!), { id: "P-1", valor: 250 });
  assert.equal(http.calls[0].headers!["idempotency-key"], `${id}:registrar`);
  const avisar = s.find((x) => x.node_id === "avisar")!;
  assert.deepEqual(avisar.output, { simulated: true, message: "Pedido P-1 registrado: ABC-9" }); // sem credencial = modo teste
});

test("condição falsa segue o outro ramo e não chama a API", async () => {
  const { workflowId, versionId } = await createPublishedWorkflow(ws, pedidoFlow());
  const { id } = await enqueueWebhook(workflowId, versionId, { id: "P-2", valor: 30 });
  const http = fakeHttp({});
  assert.equal(await new Worker(deps(http.client)).runOnce(), "succeeded");
  assert.equal(http.calls.length, 0);
  const s = await steps(id);
  assert.equal(s.find((x) => x.node_id === "pequeno")!.status, "succeeded");
  assert.equal(s.find((x) => x.node_id === "registrar")!.status, "skipped");
  assert.equal(s.find((x) => x.node_id === "avisar")!.status, "skipped");
});

test("falha de terceiro (503 e timeout) volta para a fila e, no retry, não repete o que já deu certo", async () => {
  const cred = (await owner().query<{ id: string }>(
    "INSERT INTO credentials (workspace_id, kind, name, secret_encrypted) VALUES ($1, 'discord_webhook', 'Discord', $2) RETURNING id",
    [ws, encrypt("https://discord.example/api/webhooks/1/x")],
  )).rows[0].id;
  const { workflowId, versionId } = await createPublishedWorkflow(ws, pedidoFlow(cred));
  const { id } = await enqueueWebhook(workflowId, versionId, { id: "P-3", valor: 500 });
  const http = fakeHttp({
    "https://api.exemplo.com/pedidos": [
      { status: 503, headers: { "retry-after": "1" }, body: "fora do ar" },
      new HttpFailure("sem resposta em 10000 ms", "timeout"),
      { status: 201, headers: {}, body: { protocolo: "XYZ" } },
    ],
    "https://discord.example/api/webhooks/1/x": [{ status: 204, headers: {}, body: "" }],
  });
  let waited: (number | undefined)[] = [];
  const worker = new Worker({ http: http.client, now: () => new Date(), backoff: (_n, retryAfter) => (waited.push(retryAfter), 0) });

  assert.equal(await worker.runOnce(), "requeued");
  let e = await execution(id);
  assert.equal(e.status, "queued");
  assert.match(e.error, /HTTP 503.*tentativa 1 de 3/);
  assert.deepEqual(waited, [1000]); // Retry-After do serviço chegou ao backoff

  assert.equal(await worker.runOnce(), "requeued");
  assert.equal(await worker.runOnce(), "succeeded");
  e = await execution(id);
  assert.equal(e.status, "succeeded");
  assert.equal(e.attempt, 3);

  const s = await steps(id);
  const registrar = s.filter((x) => x.node_id === "registrar").map((x) => [x.attempt, x.status]);
  assert.deepEqual(registrar, [[1, "failed"], [2, "failed"], [3, "succeeded"]]);
  // gatilho e condição rodaram uma vez só; o Discord recebeu UMA mensagem
  assert.equal(s.filter((x) => x.node_id === "grande").length, 1);
  assert.equal(http.calls.filter((c) => c.url.includes("discord")).length, 1);
  assert.deepEqual(JSON.parse(http.calls.at(-1)!.body!), { content: "Pedido P-3 registrado: XYZ" });
  // o histórico não guarda a URL secreta do webhook
  assert.ok(!JSON.stringify(s).includes("discord.example"));
});

test("falha de quem configurou (404) não tenta de novo; tentativas esgotadas viram falha", async () => {
  const { workflowId, versionId } = await createPublishedWorkflow(ws, pedidoFlow());
  const a = await enqueueWebhook(workflowId, versionId, { id: "P-4", valor: 999 });
  const http404 = fakeHttp({ "https://api.exemplo.com/pedidos": [{ status: 404, headers: {}, body: { erro: "rota" } }] });
  assert.equal(await new Worker(deps(http404.client)).runOnce(), "failed");
  const e = await execution(a.id);
  assert.equal(e.status, "failed");
  assert.match(e.error, /nó "registrar": .*HTTP 404 \(confira a configuração do nó\)/);
  assert.equal(http404.calls.length, 1);

  const b = await enqueueWebhook(workflowId, versionId, { id: "P-5", valor: 999 });
  const sempre500 = fakeHttp({ "https://api.exemplo.com/pedidos": [{ status: 500, headers: {}, body: "" }] });
  const w = new Worker(deps(sempre500.client));
  assert.equal(await w.runOnce(), "requeued");
  assert.equal(await w.runOnce(), "requeued");
  assert.equal(await w.runOnce(), "failed");
  assert.match((await execution(b.id)).error, /desistiu depois de 3 tentativas/);
});

test("credencial de outro workspace não é usada", async () => {
  const outro = await createWorkspace("Outro", [[await createUser("Beto"), "owner"]]);
  const alheia = (await owner().query<{ id: string }>(
    "INSERT INTO credentials (workspace_id, kind, name, secret_encrypted) VALUES ($1, 'discord_webhook', 'Dele', $2) RETURNING id",
    [outro, encrypt("https://discord.example/dele")],
  )).rows[0].id;
  const { workflowId, versionId } = await createPublishedWorkflow(ws, pedidoFlow(alheia));
  const { id } = await enqueueWebhook(workflowId, versionId, { id: "P-6", valor: 200 });
  const http = fakeHttp({});
  assert.equal(await new Worker(deps(http.client)).runOnce(), "failed");
  assert.match((await execution(id)).error, /credencial apagada ou de outro tipo/);
  assert.ok(!http.calls.some((c) => c.url.includes("dele")));
});

test("idempotência: o mesmo webhook reenviado não cria outra execução", async () => {
  const { workflowId, versionId } = await createPublishedWorkflow(ws, pedidoFlow());
  const a = await enqueueWebhook(workflowId, versionId, { id: 1 }, "pedido-1");
  const b = await enqueueWebhook(workflowId, versionId, { id: 1 }, "pedido-1");
  // reenvios simultâneos também
  const [c, d] = await Promise.all([enqueueWebhook(workflowId, versionId, {}, "pedido-2"), enqueueWebhook(workflowId, versionId, {}, "pedido-2")]);
  assert.equal(a.duplicate, false);
  assert.deepEqual(b, { id: a.id, duplicate: true });
  assert.equal(c.id, d.id);
  assert.equal([c.duplicate, d.duplicate].filter(Boolean).length, 1);
  assert.equal((await owner().query("SELECT count(*)::int AS n FROM executions")).rows[0].n, 2);
});

test("cota diária por workspace, inclusive com pedidos simultâneos", async () => {
  const { workflowId, versionId } = await createPublishedWorkflow(ws, pedidoFlow());
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => enqueueWebhook(workflowId, versionId, {})));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 5); // DAILY_EXECUTION_LIMIT=5
  assert.ok(results.filter((r) => r.status === "rejected").every((r) => (r as PromiseRejectedResult).reason instanceof QuotaError));
});

test("SKIP LOCKED: 4 workers em paralelo processam cada execução exatamente uma vez", async () => {
  const { workflowId, versionId } = await createPublishedWorkflow(ws, {
    nodes: [{ id: "t", type: "trigger.manual", data: {} }, { id: "h", type: "http", data: { url: "https://api.exemplo.com/{{trigger.n}}" } }],
    edges: [{ id: "e", source: "t", target: "h" }],
  });
  // cria 5 execuções (a cota do teste) direto pelo dono para não depender dela
  for (let n = 0; n < 5; n++) {
    await owner().query("INSERT INTO executions (workspace_id, workflow_id, version_id, trigger, input) VALUES ($1, $2, $3, 'manual', $4)",
      [ws, workflowId, versionId, JSON.stringify({ n })]);
  }
  const http = fakeHttp({});
  const slowHttp = async (r: HttpRequest) => (await new Promise((res) => setTimeout(res, 30)), http.client(r));
  const workers = Array.from({ length: 4 }, () => new Worker(deps(slowHttp)));
  await Promise.all(workers.map(async (w) => { while ((await w.runOnce()) !== null); }));

  const urls = http.calls.map((c) => c.url).sort();
  assert.deepEqual(urls, [0, 1, 2, 3, 4].map((n) => `https://api.exemplo.com/${n}`));
  const { rows } = await owner().query("SELECT status, attempt FROM executions");
  assert.ok(rows.every((r) => r.status === "succeeded" && r.attempt === 1));
});

test("worker que morre no meio: o lease vence, a execução volta para a fila e continua de onde parou", async () => {
  const { workflowId, versionId } = await createPublishedWorkflow(ws, pedidoFlow());
  const { id } = await enqueueWebhook(workflowId, versionId, { id: "P-7", valor: 300 });

  // worker A pega, roda até a API e "morre" ali: a chamada nunca volta e ele nunca termina
  const exec = (await claimNext("worker-A", 60_000))!;
  let reachedApi!: () => void;
  const atApi = new Promise<void>((r) => (reachedApi = r));
  void processExecution(exec, "worker-A", deps(() => (reachedApi(), new Promise<never>(() => {}))));
  await atApi;
  assert.equal((await execution(id)).status, "running");
  assert.equal((await steps(id)).length, 2); // gatilho e condição já gravados

  assert.deepEqual(await recoverExpiredLeases(), { requeued: 0, failed: 0 }); // lease ainda vale
  await owner().query("UPDATE executions SET locked_until = now() - interval '1 second' WHERE id = $1", [id]);
  assert.deepEqual(await recoverExpiredLeases(), { requeued: 1, failed: 0 });

  // worker B termina; gatilho e condição não rodam de novo
  const httpB = fakeHttp({ "https://api.exemplo.com/pedidos": [{ status: 200, headers: {}, body: { protocolo: "OK" } }] });
  assert.equal(await new Worker(deps(httpB.client)).runOnce(), "succeeded");
  const s = await steps(id);
  assert.equal(s.filter((x) => x.node_id === "grande").length, 1);
  assert.equal((await execution(id)).attempt, 2);

  // e se o worker A "acordar" agora, não consegue gravar nada por cima (fencing)
  assert.equal(await processExecution(exec, "worker-A", deps(httpB.client)), "lost");
});

test("cancelar no meio: o worker para no próximo passo", async () => {
  const { workflowId, versionId } = await createPublishedWorkflow(ws, pedidoFlow());
  const { id } = await enqueueWebhook(workflowId, versionId, { id: "P-8", valor: 300 });
  const http = fakeHttp({});
  const cancelling = async (r: HttpRequest) => {
    await owner().query("UPDATE executions SET status = 'canceled', finished_at = now(), locked_by = NULL, locked_until = NULL WHERE id = $1", [id]);
    return http.client(r);
  };
  assert.equal(await new Worker(deps(cancelling)).runOnce(), "lost");
  assert.equal((await execution(id)).status, "canceled");
  assert.ok(!(await steps(id)).some((x) => x.node_id === "avisar"));
});

test("agendador: cria a execução vencida uma vez só e marca a próxima", async () => {
  const { workflowId } = await createPublishedWorkflow(ws, {
    nodes: [{ id: "t", type: "trigger.schedule", data: { cron: "0 9 * * *", timezone: "America/Sao_Paulo" } }],
    edges: [],
  });
  await owner().query(
    "INSERT INTO workflow_triggers (workspace_id, workflow_id, kind, cron, timezone, next_run_at) VALUES ($1, $2, 'schedule', '0 9 * * *', 'America/Sao_Paulo', now() - interval '3 days')",
    [ws, workflowId],
  );
  const [a, b] = await Promise.all([runDueSchedules(), runDueSchedules()]); // duas instâncias ao mesmo tempo
  assert.equal(a.enqueued + b.enqueued, 1); // 3 dias perdidos viram UMA execução, não três
  const t = (await owner().query("SELECT next_run_at FROM workflow_triggers")).rows[0];
  assert.ok(t.next_run_at > new Date());
  assert.equal(new Date(t.next_run_at).getUTCHours(), 12); // 9h em São Paulo
  assert.deepEqual(await runDueSchedules(), { enqueued: 0, skipped: 0 });

  // fluxo desativado não dispara
  await owner().query("UPDATE workflow_triggers SET next_run_at = now() - interval '1 minute'");
  await owner().query("UPDATE workflows SET is_active = false");
  assert.deepEqual(await runDueSchedules(), { enqueued: 0, skipped: 0 });
});

test("erro nosso (bug) também tenta de novo, e o histórico mostra mensagem genérica, sem detalhe interno", async () => {
  const { workflowId, versionId } = await createPublishedWorkflow(ws, pedidoFlow());
  const { id } = await enqueueWebhook(workflowId, versionId, { id: "P-9", valor: 300 });
  const bug = fakeHttp({ "https://api.exemplo.com/pedidos": [new TypeError("Cannot read properties of undefined at /app/dist/engine.js:42")] });
  const original = console.error;
  console.error = () => {}; // o log com o id da execução é esperado aqui
  try {
    assert.equal(await new Worker(deps(bug.client)).runOnce(), "requeued");
  } finally {
    console.error = original;
  }
  const failed = (await steps(id)).find((x) => x.status === "failed")!;
  assert.equal(failed.error, "erro interno do motor");
  assert.ok(!JSON.stringify(await execution(id)).includes("/app/dist"));
});
