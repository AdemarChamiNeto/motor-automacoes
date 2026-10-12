import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createPublishedWorkflow, createUser, createWorkspace, owner, resetDb } from "../testing/db.js";

const { asUser, asSystem, closePool, getPool, pgCode, PG } = await import("./pool.js");

/**
 * Isolamento entre workspaces garantido pelo banco (RLS), não só pela API:
 * mesmo uma consulta sem filtro só enxerga o que é dos workspaces do usuário.
 */
let ana: string, beto: string, caio: string, dani: string, loja: string, outro: string, workflowId: string;

before(async () => {
  await resetDb();
  [ana, beto, caio, dani] = await Promise.all([createUser("Ana"), createUser("Beto"), createUser("Caio"), createUser("Dani")]);
  loja = await createWorkspace("Loja", [[ana, "owner"], [beto, "editor"], [caio, "viewer"]]);
  outro = await createWorkspace("Outro", [[dani, "owner"]]);
  ({ workflowId } = await createPublishedWorkflow(loja, { nodes: [{ id: "t", type: "trigger.manual", data: {} }], edges: [] }, "Da loja"));
  await createPublishedWorkflow(outro, { nodes: [{ id: "t", type: "trigger.manual", data: {} }], edges: [] }, "Da Dani");
  await owner().query("INSERT INTO credentials (workspace_id, kind, name, secret_encrypted) VALUES ($1, 'slack_webhook', 'Slack', 'v1:a:b:c')", [loja]);
  await owner().query("INSERT INTO user_passwords (user_id, password_hash) VALUES ($1, $2)", [ana, "$2b$12$abcdefghijklmnopqrstuv"]);
});
after(closePool);

async function fails(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e) => {
    assert.equal(pgCode(e), code, (e as Error).message);
    return true;
  });
}

test("consulta sem filtro só vê o próprio workspace", async () => {
  const names = await asUser(caio, async (c) => (await c.query("SELECT name FROM workflows ORDER BY name")).rows.map((r) => r.name));
  assert.deepEqual(names, ["Da loja"]);
  const daniSees = await asUser(dani, async (c) => (await c.query("SELECT name FROM workspaces")).rows.map((r) => r.name));
  assert.deepEqual(daniSees, ["Outro"]);
  // colegas visíveis (nome e e-mail), estranhos não
  const people = await asUser(caio, async (c) => (await c.query("SELECT name FROM users ORDER BY name")).rows.map((r) => r.name));
  assert.deepEqual(people, ["Ana", "Beto", "Caio"]);
});

test("sem usuário na transação, não vê nada; senha e 2FA nem com usuário", async () => {
  const c = await getPool().connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL ROLE motor_app");
    assert.equal((await c.query("SELECT count(*)::int AS n FROM workflows")).rows[0].n, 0);
    await c.query("ROLLBACK");
  } finally {
    c.release();
  }
  await fails(asUser(ana, (c) => c.query("SELECT * FROM user_passwords")), PG.insufficientPrivilege);
  await fails(asUser(ana, (c) => c.query("SELECT * FROM user_totp")), PG.insufficientPrivilege);
});

test("segredo da credencial não sai nem para o owner; só o sistema (worker) lê", async () => {
  await fails(asUser(ana, (c) => c.query("SELECT secret_encrypted FROM credentials")), PG.insufficientPrivilege);
  await fails(asUser(ana, (c) => c.query("SELECT * FROM credentials")), PG.insufficientPrivilege);
  const listed = await asUser(caio, async (c) => (await c.query("SELECT name, kind FROM credentials")).rows);
  assert.deepEqual(listed, [{ name: "Slack", kind: "slack_webhook" }]);
  const sys = await asSystem(async (c) => (await c.query("SELECT secret_encrypted FROM credentials")).rows);
  assert.equal(sys.length, 1);
});

test("viewer não escreve; editor escreve fluxo mas não mexe em membros nem em outro workspace", async () => {
  await fails(asUser(caio, (c) => c.query("INSERT INTO workflows (workspace_id, name, draft) VALUES ($1, 'x', '{}')", [loja])), PG.insufficientPrivilege);
  const upd = await asUser(caio, (c) => c.query("UPDATE workflows SET name = 'hack'"));
  assert.equal(upd.rowCount, 0); // a linha nem é "vista" para o UPDATE

  await asUser(beto, (c) => c.query("INSERT INTO workflows (workspace_id, name, draft, created_by) VALUES ($1, 'Do Beto', '{}', $2)", [loja, beto]));
  const promote = await asUser(beto, (c) => c.query("UPDATE workspace_members SET role = 'owner' WHERE user_id = $1", [beto]));
  assert.equal(promote.rowCount, 0);
  // escrever no workspace dos outros: barrado mesmo sabendo o id
  await fails(asUser(beto, (c) => c.query("INSERT INTO workflows (workspace_id, name, draft) VALUES ($1, 'invasão', '{}')", [outro])), PG.insufficientPrivilege);
});

test("execução manual: só editor, só como 'manual' e em nome de si mesmo", async () => {
  const v = (await owner().query("SELECT published_version_id AS id FROM workflows WHERE id = $1", [workflowId])).rows[0].id;
  const insert = (who: string, trigger: string, createdBy: string) =>
    asUser(who, (c) => c.query("INSERT INTO executions (workspace_id, workflow_id, version_id, trigger, created_by) VALUES ($1, $2, $3, $4, $5)",
      [loja, workflowId, v, trigger, createdBy]));
  await insert(beto, "manual", beto);
  await fails(insert(caio, "manual", caio), PG.insufficientPrivilege);
  await fails(insert(beto, "webhook", beto), PG.insufficientPrivilege);
  await fails(insert(beto, "manual", ana), PG.insufficientPrivilege);
});

test("o workspace nunca fica sem owner, nem com dois rebaixamentos ao mesmo tempo", async () => {
  await fails(asUser(ana, (c) => c.query("UPDATE workspace_members SET role = 'editor' WHERE user_id = $1", [ana])), PG.checkViolation);
  await fails(asUser(ana, (c) => c.query("DELETE FROM workspace_members WHERE user_id = $1", [ana])), PG.checkViolation);

  // dois owners: cada um tenta rebaixar o outro ao mesmo tempo; um dos dois tem que falhar
  await asUser(ana, (c) => c.query("UPDATE workspace_members SET role = 'owner' WHERE user_id = $1", [beto]));
  const results = await Promise.allSettled([
    asUser(ana, (c) => c.query("UPDATE workspace_members SET role = 'editor' WHERE user_id = $1", [beto])),
    asUser(beto, (c) => c.query("UPDATE workspace_members SET role = 'editor' WHERE user_id = $1", [ana])),
  ]);
  assert.equal(results.filter((r) => r.status === "rejected").length, 1);
  const owners = (await owner().query("SELECT count(*)::int AS n FROM workspace_members WHERE workspace_id = $1 AND role = 'owner'", [loja])).rows[0].n;
  assert.equal(owners, 1);

  // sair do workspace (apagar a própria linha) é permitido para quem não é o último owner
  const out = await asUser(caio, (c) => c.query("DELETE FROM workspace_members WHERE user_id = $1", [caio]));
  assert.equal(out.rowCount, 1);
});

test("versão publicada é imutável", async () => {
  await fails(owner().query("UPDATE workflow_versions SET definition = '{}'"), PG.checkViolation);
});
