import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { owner, resetDb } from "../testing/db.js";

// os testes criam muitas contas do mesmo IP; os limites têm teste próprio no fim
process.env.AUTH_RATE_LIMIT = "1000";
process.env.WRITE_RATE_LIMIT = "1000";
process.env.READ_RATE_LIMIT = "1000";
process.env.DEMO_RATE_LIMIT = "1000";

const { createApp } = await import("./app.js");
const { closePool } = await import("../db/pool.js");
const { Worker } = await import("../engine/worker.js");
const { codeForStep, stepAt } = await import("../security/totp.js");
const { openapi } = await import("./openapi.js");

let server: Server;
let origin = "";

before(async () => {
  await resetDb();
  server = createApp().listen(0);
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  server.close();
  await closePool();
});

type Res = { status: number; json: any; headers: Headers; cookie: string };

/** Cliente com "cookie jar" simples: guarda o cookie de sessão entre chamadas. */
class Client {
  cookie = "";
  async call(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
    const res = await fetch(origin + (url.startsWith("/hooks") ? url : `/api${url}`), {
      method,
      headers: { "content-type": "application/json", ...(this.cookie ? { cookie: this.cookie } : {}), ...headers },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    const set = res.headers.getSetCookie().map((c) => c.split(";")[0]);
    for (const c of set) {
      const [name] = c.split("=");
      const rest = this.cookie.split("; ").filter((x) => x && !x.startsWith(name + "="));
      this.cookie = [...rest, ...(c.endsWith("=") ? [] : [c])].join("; ");
    }
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, json, headers: res.headers, cookie: this.cookie };
  }
  get = (u: string) => this.call("GET", u);
  post = (u: string, b?: unknown, h?: Record<string, string>) => this.call("POST", u, b ?? {}, h);
  patch = (u: string, b: unknown) => this.call("PATCH", u, b);
  del = (u: string) => this.call("DELETE", u);
}

let n = 0;
async function signup(name = "Ana Souza"): Promise<{ c: Client; ws: string; email: string }> {
  const c = new Client();
  const email = `pessoa${++n}@exemplo.com`;
  const r = await c.post("/auth/register", { name, email, password: "senha-forte-123" });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const list = await c.get("/workspaces");
  return { c, ws: list.json[0].id, email };
}

const webhookFlow = {
  nodes: [
    { id: "entrada", type: "trigger.webhook", position: { x: 0, y: 0 }, data: {} },
    { id: "alto", type: "condition", position: { x: 200, y: 0 }, data: { left: "{{trigger.body.valor}}", operator: "gte", right: "100" } },
    { id: "avisar", type: "notify.discord", position: { x: 400, y: 0 }, data: { message: "Valor {{trigger.body.valor}}" } },
  ],
  edges: [
    { id: "e1", source: "entrada", target: "alto" },
    { id: "e2", source: "alto", target: "avisar", sourceHandle: "true" },
  ],
};

const worker = () => new Worker({ http: async () => ({ status: 200, headers: {}, body: { ok: true } }), now: () => new Date(), backoff: () => 0 });

test("cadastro cria o workspace pessoal com os fluxos de exemplo publicados; login, /me e logout", async () => {
  const { c, ws, email } = await signup("Bruno Lima");
  const me = await c.get("/auth/me");
  assert.equal(me.json.name, "Bruno Lima");
  const list = await c.get("/workspaces");
  assert.deepEqual(list.json.map((w: any) => [w.name, w.role]), [["Workspace de Bruno", "owner"]]);
  const flows = await c.get(`/workspaces/${ws}/workflows`);
  assert.deepEqual(flows.json.map((f: any) => [f.name, f.publishedVersion, f.isActive]), [
    ["Cotação do dólar", 1, false], ["Monitor do GitHub", 1, false], ["Pedido grande", 1, false], ["Triagem de chamado com IA", 1, false],
  ]);

  assert.equal((await c.post("/auth/logout")).status, 204);
  assert.equal((await c.get("/auth/me")).status, 401);
  const wrong = await new Client().post("/auth/login", { email, password: "errada-123" });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.json.error, "E-mail ou senha incorretos");
  const login = await c.post("/auth/login", { email: email.toUpperCase(), password: "senha-forte-123" });
  assert.equal(login.status, 200);
  assert.equal((await new Client().post("/auth/register", { name: "Outro", email, password: "senha-forte-123" })).status, 409);
  const bad = await new Client().post("/auth/register", { name: "X", email: "nao-e-email", password: "123" });
  assert.equal(bad.status, 400);
  assert.ok(bad.json.details.some((d: any) => d.field === "password"));
});

test("experimentar sem cadastro: conta temporária com fluxos e prazo de 24 h", async () => {
  const c = new Client();
  const r = await c.post("/auth/demo");
  assert.equal(r.status, 201);
  assert.match(r.json.user.email, /@demo\.invalid$/);
  const hours = (new Date(r.json.user.demoExpiresAt).getTime() - Date.now()) / 3_600_000;
  assert.ok(hours > 23.9 && hours <= 24);
  const ws = (await c.get("/workspaces")).json[0].id;
  assert.equal((await c.get(`/workspaces/${ws}/workflows`)).json.length, 4);
});

test("do rascunho ao webhook: publicar, ativar, disparar, idempotência, desligar", async () => {
  const { c, ws } = await signup();
  const created = await c.post(`/workspaces/${ws}/workflows`, { name: "Alerta de valor", draft: webhookFlow });
  assert.equal(created.status, 201);
  assert.deepEqual(created.json.problems, []);
  const wf = `/workspaces/${ws}/workflows/${created.json.id}`;

  assert.equal((await c.post(`${wf}/activate`)).status, 409); // sem publicar
  const pub = await c.post(`${wf}/publish`);
  assert.equal(pub.status, 200);
  assert.equal(pub.json.version, 1);
  const hookPath = new URL(pub.json.webhookUrl).pathname;
  assert.match(hookPath, /^\/hooks\/[A-Za-z0-9_-]{43}$/);

  // desligado: o webhook responde 404, igual a token errado (não revela que o fluxo existe)
  assert.equal((await c.post(hookPath, { valor: 150 })).status, 404);
  assert.equal((await c.post(`${wf}/activate`)).status, 200);

  const hook = new Client(); // sistema de fora: sem cookie
  const sent = await hook.post(hookPath, { valor: 150, cliente: "Loja X" }, { "idempotency-key": "pedido-77" });
  assert.equal(sent.status, 202);
  const again = await hook.post(hookPath, { valor: 150, cliente: "Loja X" }, { "idempotency-key": "pedido-77" });
  assert.deepEqual([again.status, again.json.executionId, again.json.duplicate], [200, sent.json.executionId, true]);

  assert.equal(await worker().runOnce(), "succeeded");
  const exec = await c.get(`${wf}/executions/${sent.json.executionId}`);
  assert.equal(exec.json.status, "succeeded");
  assert.equal(exec.json.trigger, "webhook");
  assert.deepEqual(exec.json.input.body, { valor: 150, cliente: "Loja X" });
  assert.deepEqual(exec.json.steps.map((s: any) => [s.nodeId, s.status]), [["entrada", "succeeded"], ["alto", "succeeded"], ["avisar", "succeeded"]]);
  assert.deepEqual(exec.json.steps[2].output, { simulated: true, message: "Valor 150" });

  // republicar não troca a URL; girar o token troca e mata a antiga
  const pub2 = await c.post(`${wf}/publish`);
  assert.deepEqual([pub2.json.version, pub2.json.webhookUrl], [2, null]);
  const rotated = await c.post(`${wf}/webhook/rotate`);
  assert.equal((await hook.post(hookPath, { valor: 1 })).status, 404);
  assert.equal((await hook.post(new URL(rotated.json.webhookUrl).pathname, { valor: 1 })).status, 202);

  await c.post(`${wf}/deactivate`);
  assert.equal((await hook.post(new URL(rotated.json.webhookUrl).pathname, {})).status, 404);
});

test("webhook: corpo grande, JSON quebrado, token malformado e método errado", async () => {
  const { c, ws } = await signup();
  const created = await c.post(`/workspaces/${ws}/workflows`, { name: "Hook", draft: webhookFlow });
  const wf = `/workspaces/${ws}/workflows/${created.json.id}`;
  const hookPath = new URL((await c.post(`${wf}/publish`)).json.webhookUrl).pathname;
  await c.post(`${wf}/activate`);
  const hook = new Client();
  assert.equal((await hook.post(hookPath, { grande: "x".repeat(300_000) })).status, 413);
  assert.equal((await hook.post(hookPath, "{não é json")).status, 400);
  assert.equal((await hook.post("/hooks/curto", {})).status, 404);
  assert.equal((await hook.get(hookPath)).status, 405);
  assert.equal((await hook.post(hookPath, {}, { "idempotency-key": "x".repeat(201) })).status, 400);
  // o webhook não recebe cookie de sessão nem expõe CORS
  const r = await hook.post(hookPath, {}, { origin: "https://outro-site.example" });
  assert.equal(r.headers.get("access-control-allow-origin"), null);
});

test("publicar com problemas devolve 422 apontando o nó; credencial de outro tipo também", async () => {
  const { c, ws } = await signup();
  const solto = { nodes: [...webhookFlow.nodes, { id: "perdido", type: "notify.slack", data: { message: "x" } }], edges: webhookFlow.edges };
  const created = await c.post(`/workspaces/${ws}/workflows`, { name: "Com problema", draft: solto });
  assert.deepEqual(created.json.problems, [{ nodeId: "perdido", message: "nó solto: não está ligado ao gatilho" }]);
  const pub = await c.post(`/workspaces/${ws}/workflows/${created.json.id}/publish`);
  assert.equal(pub.status, 422);
  assert.equal(pub.json.details[0].nodeId, "perdido");

  const slack = await c.post(`/workspaces/${ws}/credentials`, { name: "Slack do time", secret: { kind: "slack_webhook", url: "https://hooks.slack.com/services/T000/B000/XXXX" } });
  assert.equal(slack.status, 201);
  const wrongKind = structuredClone(webhookFlow);
  (wrongKind.nodes[2].data as any).credentialId = slack.json.id; // nó do Discord com credencial do Slack
  const f2 = await c.post(`/workspaces/${ws}/workflows`, { name: "Tipo errado", draft: wrongKind });
  const pub2 = await c.post(`/workspaces/${ws}/workflows/${f2.json.id}/publish`);
  assert.equal(pub2.status, 422);
  assert.deepEqual(pub2.json.details, [{ nodeId: "avisar", message: "credencial de outro tipo" }]);
});

test("credenciais: formato validado por serviço e o segredo nunca volta", async () => {
  const { c, ws } = await signup();
  const base = `/workspaces/${ws}/credentials`;
  assert.equal((await c.post(base, { name: "x", secret: { kind: "discord_webhook", url: "https://meu-servidor.example/coleta" } })).status, 400);
  assert.equal((await c.post(base, { name: "x", secret: { kind: "telegram_bot", token: "abc" } })).status, 400);
  const ok = await c.post(base, { name: "Discord", secret: { kind: "discord_webhook", url: "https://discord.com/api/webhooks/123/abc-DEF_9" } });
  assert.equal(ok.status, 201);
  assert.equal((await c.post(base, { name: "Discord", secret: { kind: "telegram_bot", token: "123456:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789" } })).status, 409);
  const list = await c.get(base);
  assert.equal(JSON.stringify(list.json).includes("webhooks/123"), false);
  assert.deepEqual(Object.keys(list.json[0]).sort(), ["createdAt", "createdBy", "id", "kind", "name", "updatedAt"]);
  const renamed = await c.patch(`${base}/${ok.json.id}`, { name: "Discord do time", secret: { kind: "discord_webhook", url: "https://discord.com/api/webhooks/9/z" } });
  assert.equal(renamed.json.name, "Discord do time");
  assert.equal((await c.patch(`${base}/${ok.json.id}`, { secret: { kind: "slack_webhook", url: "https://hooks.slack.com/services/a" } })).status, 400);
  assert.equal((await c.del(`${base}/${ok.json.id}`)).status, 204);
  assert.equal((await c.get(base)).json.length, 0);
});

test("IA: chave validada por provedor e o nó só publica com a chave do provedor escolhido", async () => {
  const { c, ws } = await signup();
  const base = `/workspaces/${ws}/credentials`;
  assert.equal((await c.post(base, { name: "x", secret: { kind: "anthropic_key", key: "AIza" + "NaoEhDaAnthropic000000000000000000" } })).status, 400);
  assert.equal((await c.post(base, { name: "x", secret: { kind: "gemini_key", key: "curta" } })).status, 400);
  const claude = await c.post(base, { name: "Claude", secret: { kind: "anthropic_key", key: "sk-ant-api03-chave-falsa-de-teste-0000000000" } });
  assert.equal(claude.status, 201);
  // montada em partes para o scanner de segredos do GitHub não confundir a chave fictícia com uma de verdade
  const gemini = await c.post(base, { name: "Gemini", secret: { kind: "gemini_key", key: "AIza" + "ChaveFalsaDeTeste000000000000000000" } });
  assert.equal(gemini.status, 201);
  // formato novo do AI Studio (com ponto)
  const novo = await c.post(base, { name: "Gemini novo", secret: { kind: "gemini_key", key: "AQ.Ab8RN6ChaveFalsaDeTesteNoFormatoNovo_0000-xyz" } });
  assert.equal(novo.status, 201);
  assert.equal((await c.post(base, { name: "x", secret: { kind: "gemini_key", key: "AQ.com espaço e quebra\nde linha 0000000000" } })).status, 400);
  assert.equal(JSON.stringify((await c.get(base)).json).includes("sk-ant"), false);

  const flow = (provider: string, credentialId: string) => ({
    nodes: [
      { id: "g", type: "trigger.manual", data: {} },
      { id: "ia", type: "ai", data: { provider, credentialId, instructions: "Resuma.", input: "{{trigger.body.texto}}" } },
    ],
    edges: [{ id: "e", source: "g", target: "ia" }],
  });
  const errado = await c.post(`/workspaces/${ws}/workflows`, { name: "Claude com chave do Gemini", draft: flow("anthropic", gemini.json.id) });
  const pub = await c.post(`/workspaces/${ws}/workflows/${errado.json.id}/publish`);
  assert.equal(pub.status, 422);
  assert.deepEqual(pub.json.details, [{ nodeId: "ia", message: "credencial de outro tipo" }]);
  const certo = await c.post(`/workspaces/${ws}/workflows`, { name: "Claude", draft: flow("anthropic", claude.json.id) });
  assert.equal((await c.post(`/workspaces/${ws}/workflows/${certo.json.id}/publish`)).status, 200);
});

test("papéis e isolamento: viewer só lê, quem não é membro recebe 404, id de outro workspace não vaza", async () => {
  const ana = await signup("Ana");
  const caio = await signup("Caio");
  const invite = await ana.c.post(`/workspaces/${ana.ws}/invites`, { role: "viewer" });
  assert.equal(invite.status, 201);
  const token = new URL(invite.json.link).hash.slice(1);
  assert.equal((await caio.c.post("/invites/accept-link", { token })).status, 200);
  assert.equal((await caio.c.post("/invites/accept-link", { token })).status, 404); // uso único

  const flows = await caio.c.get(`/workspaces/${ana.ws}/workflows`);
  assert.equal(flows.status, 200);
  assert.equal((await caio.c.post(`/workspaces/${ana.ws}/workflows`, { name: "do viewer" })).status, 403);
  assert.equal((await caio.c.post(`/workspaces/${ana.ws}/workflows/${flows.json[0].id}/run`)).status, 403);
  assert.equal((await caio.c.del(`/workspaces/${ana.ws}`)).status, 403);

  const estranho = await signup("Estranho");
  assert.equal((await estranho.c.get(`/workspaces/${ana.ws}/workflows`)).status, 404);
  assert.equal((await estranho.c.get(`/workspaces/${ana.ws}`)).status, 404);
  assert.equal((await estranho.c.get(`/workspaces/nao-e-uuid/workflows`)).status, 404);
  // fluxo da Ana pedido pelo workspace do estranho: 404, não 403
  assert.equal((await estranho.c.get(`/workspaces/${estranho.ws}/workflows/${flows.json[0].id}`)).status, 404);
  assert.equal((await estranho.c.post(`/workspaces/${estranho.ws}/workflows/${flows.json[0].id}/run`)).status, 404);

  // o owner promove o Caio a editor; aí ele roda
  await ana.c.patch(`/workspaces/${ana.ws}/members/${(await caio.c.get("/auth/me")).json.id}`, { role: "editor" });
  assert.equal((await caio.c.post(`/workspaces/${ana.ws}/workflows/${flows.json[0].id}/run`)).status, 202);
});

test("convite por e-mail: mesma resposta com ou sem conta; aparece para quem tem o e-mail; último owner não sai", async () => {
  const ana = await signup("Ana");
  const beto = await signup("Beto");
  const r1 = await ana.c.post(`/workspaces/${ana.ws}/invites`, { role: "editor", email: beto.email.toUpperCase() });
  const r2 = await ana.c.post(`/workspaces/${ana.ws}/invites`, { role: "editor", email: "ninguem@exemplo.com" });
  assert.deepEqual([r1.status, r2.status], [201, 201]);
  assert.deepEqual(Object.keys(r1.json).sort(), Object.keys(r2.json).sort());
  assert.equal(r1.json.message, r2.json.message);

  const pending = await beto.c.get("/invites");
  assert.deepEqual(pending.json.map((i: any) => [i.workspace, i.role, i.invitedBy]), [["Workspace de Ana", "editor", "Ana"]]);
  assert.equal((await ana.c.get("/invites")).json.length, 0);
  assert.equal((await beto.c.post(`/invites/${pending.json[0].id}/accept`)).status, 200);
  assert.equal((await beto.c.get("/invites")).json.length, 0);
  assert.deepEqual((await beto.c.get("/workspaces")).json.map((w: any) => w.role).sort(), ["editor", "owner"]);

  const anaId = (await ana.c.get("/auth/me")).json.id;
  const leave = await ana.c.del(`/workspaces/${ana.ws}/members/${anaId}`);
  assert.equal(leave.status, 409);
  assert.equal(leave.json.error, "O workspace precisa de pelo menos um owner");
  const betoId = (await beto.c.get("/auth/me")).json.id;
  assert.equal((await beto.c.del(`/workspaces/${ana.ws}/members/${betoId}`)).status, 204); // sair
});

test("execução manual, histórico paginado por cursor e cancelamento", async () => {
  const { c, ws } = await signup();
  const flow = (await c.get(`/workspaces/${ws}/workflows`)).json.find((f: any) => f.name === "Pedido grande");
  const wf = `/workspaces/${ws}/workflows/${flow.id}`;
  const ids: string[] = [];
  for (let i = 0; i < 5; i++) ids.push((await c.post(`${wf}/run`, { input: { valor: 1000 + i, id: i } })).json.executionId);

  const p1 = await c.get(`${wf}/executions?limit=2`);
  assert.equal(p1.json.items.length, 2);
  assert.equal(p1.json.items[0].id, ids[4]); // mais recente primeiro
  const p2 = await c.get(`${wf}/executions?limit=2&cursor=${encodeURIComponent(p1.json.nextCursor)}`);
  const p3 = await c.get(`${wf}/executions?limit=2&cursor=${encodeURIComponent(p2.json.nextCursor)}`);
  assert.deepEqual([...p1.json.items, ...p2.json.items, ...p3.json.items].map((e: any) => e.id), [...ids].reverse());
  assert.equal(p3.json.nextCursor, null);
  assert.equal((await c.get(`${wf}/executions?cursor=lixo`)).status, 400);

  assert.equal((await c.post(`${wf}/executions/${ids[0]}/cancel`)).status, 200);
  assert.equal((await c.post(`${wf}/executions/${ids[0]}/cancel`)).status, 409);
  const w = worker();
  while ((await w.runOnce()) !== null);
  const done = await c.get(`${wf}/executions?status=succeeded`);
  assert.equal(done.json.items.length, 4);
  assert.equal((await c.get(`${wf}/executions?status=canceled`)).json.items[0].id, ids[0]);
});

test("2FA: ativar, login em dois passos, código não reutilizável e recuperação", async () => {
  const { c, email } = await signup();
  const setup = await c.post("/auth/2fa/setup");
  const step = stepAt(new Date());
  assert.equal((await c.post("/auth/2fa/enable", { code: "000000" })).status, 400);
  const enabled = await c.post("/auth/2fa/enable", { code: codeForStep(setup.json.secret, step) });
  assert.equal(enabled.json.recoveryCodes.length, 10);

  const d = new Client();
  const first = await d.post("/auth/login", { email, password: "senha-forte-123" });
  assert.deepEqual(first.json, { twoFactorRequired: true });
  assert.equal((await d.get("/auth/me")).status, 401); // o cookie pendente não é sessão
  assert.equal((await d.post("/auth/login/2fa", { code: codeForStep(setup.json.secret, step) })).status, 401); // já usado no enable
  const second = await d.post("/auth/login/2fa", { code: codeForStep(setup.json.secret, step + 1) });
  assert.equal(second.status, 200);
  assert.equal(second.json.user.twoFactorEnabled, true);

  const e = new Client();
  await e.post("/auth/login", { email, password: "senha-forte-123" });
  const rec = await e.post("/auth/login/2fa", { code: enabled.json.recoveryCodes[0] });
  assert.equal(rec.json.recoveryCodesLeft, 9);
  // senha e 2FA nunca aparecem em texto no banco
  const { rows } = await owner().query("SELECT p.password_hash, t.secret_encrypted FROM user_passwords p JOIN user_totp t USING (user_id) JOIN users u ON u.id = p.user_id WHERE u.email = $1", [email]);
  assert.match(rows[0].password_hash, /^\$2[aby]\$12\$/);
  assert.ok(!rows[0].secret_encrypted.includes(setup.json.secret));
});

test("rate limit: força bruta no login e rajada no webhook recebem 429 com Retry-After", async () => {
  const saved = { ...process.env };
  process.env.AUTH_RATE_LIMIT = "3";
  process.env.HOOK_RATE_LIMIT = "2";
  const app = createApp().listen(0);
  const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  try {
    const login = () => fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "x@exemplo.com", password: "errada" }) });
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await login()).status);
    assert.deepEqual(codes, [401, 401, 401, 429]);
    const last = await login();
    assert.ok(Number(last.headers.get("retry-after")) > 0);

    const hook = () => fetch(`${base}/hooks/${"a".repeat(43)}`, { method: "POST" });
    assert.deepEqual([(await hook()).status, (await hook()).status, (await hook()).status], [404, 404, 429]);
  } finally {
    app.close();
    Object.assign(process.env, saved);
  }
});

test("cabeçalhos de segurança, 404 em JSON e cookie de sessão httpOnly", async () => {
  const c = new Client();
  const r = await c.post("/auth/demo");
  const raw = r.headers.getSetCookie().join(" | ");
  assert.match(raw, /motor_session=.*HttpOnly/i);
  assert.match(raw, /SameSite=Lax/i);
  assert.match(raw, /Path=\/api/);
  const h = await c.get("/rota-que-nao-existe");
  assert.equal(h.status, 404);
  assert.equal(h.json.error, "Rota não encontrada");
  assert.ok(h.headers.get("content-security-policy")?.includes("frame-ancestors 'self'"));
  assert.equal(h.headers.get("x-content-type-options"), "nosniff");
  assert.equal(h.headers.get("x-powered-by"), null);
});

test("site: endereço real nas metatags, robots/sitemap/llms, noindex na área logada e 404 de verdade", async () => {
  const dir = fs.mkdtempSync(path.join(process.env.TEMP ?? "/tmp", "motor-site-"));
  fs.writeFileSync(path.join(dir, "index.html"), '<html><head><link rel="canonical" href="__PUBLIC_URL__/entrar"></head><body>app</body></html>');
  fs.writeFileSync(path.join(dir, "404.html"), "<h1>Página não encontrada</h1>");
  process.env.PUBLIC_URL = "https://motor.exemplo.com";
  const app = createApp({ staticDir: dir }).listen(0);
  const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  try {
    const entrar = await fetch(`${base}/entrar`);
    const html = await entrar.text();
    assert.equal(entrar.status, 200);
    assert.match(html, /href="https:\/\/motor\.exemplo\.com\/entrar"/);
    assert.doesNotMatch(html, /noindex/);
    const fluxo = await (await fetch(`${base}/w/${"0".repeat(8)}-0000-0000-0000-${"0".repeat(12)}/fluxos/${"1".repeat(8)}-1111-1111-1111-${"1".repeat(12)}`)).text();
    assert.match(fluxo, /<meta name="robots" content="noindex"/);
    const missing = await fetch(`${base}/nao-existe`);
    assert.equal(missing.status, 404);
    assert.match(await missing.text(), /Página não encontrada/);
    assert.equal((await fetch(`${base}/w/nao-e-uuid`)).status, 404);
    assert.equal((await fetch(`${base}/assets/nao-existe.js`)).status, 404); // e não 500
    const robots = await (await fetch(`${base}/robots.txt`)).text();
    assert.match(robots, /Disallow: \/api\//);
    assert.match(robots, /Sitemap: https:\/\/motor\.exemplo\.com\/sitemap\.xml/);
    assert.match(await (await fetch(`${base}/sitemap.xml`)).text(), /<loc>https:\/\/motor\.exemplo\.com\/entrar<\/loc>/);
    assert.match(await (await fetch(`${base}/llms.txt`)).text(), /^# Motor de Automações/);
    assert.equal((await fetch(`${base}/api/nao-existe`)).headers.get("content-type")?.includes("json"), true); // API continua JSON
  } finally {
    app.close();
    delete process.env.PUBLIC_URL;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("OpenAPI: toda rota real está documentada (e nenhuma documentada some)", async () => {
  // rotas declaradas no código: r.get("/x"), one.post("/y")... com o prefixo de cada arquivo
  const prefixes: Record<string, string> = {
    "auth.ts": "/auth", "workspaces.ts": "", "credentials.ts": "/workspaces/{ws}/credentials",
    "workflows.ts": "/workspaces/{ws}/workflows", "hooks.ts": "/../hooks",
  };
  const declared = new Set<string>(["get /health", "get /docs.json"]);
  const dir = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "routes");
  for (const file of fs.readdirSync(dir)) {
    const src = fs.readFileSync(path.join(dir, file), "utf8");
    for (const m of src.matchAll(/\b(r|ws|one)\.(get|post|patch|delete)\(\s*"([^"]*)"/g)) {
      let p = m[3].replace(/:(\w+)/g, "{$1}").replace(/\/$/, "");
      if (file === "workspaces.ts") p = (m[1] === "ws" ? "/workspaces/{ws}" : m.index! > src.indexOf("export function invitesRouter") ? "/invites" : "/workspaces") + p;
      else if (m[1] === "one") p = `${prefixes[file]}/{id}${p}`;
      else p = prefixes[file] + p;
      declared.add(`${m[2]} ${p || "/"}`);
    }
  }
  declared.delete("get /docs.json");
  const documented = new Set(Object.entries(openapi.paths).flatMap(([p, ops]) => Object.keys(ops).map((m) => `${m} ${p}`)));
  assert.deepEqual([...declared].filter((d) => !documented.has(d)), [], "rotas sem documentação");
  assert.deepEqual([...documented].filter((d) => !declared.has(d)), [], "documentação de rota que não existe");

  const page = await fetch(`${origin}/api/docs/`);
  assert.equal(page.status, 200);
});
