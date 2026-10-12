import test from "node:test";
import assert from "node:assert/strict";
import { validateDefinition } from "./definition.js";
import { evaluate } from "./condition.js";
import { renderJson, renderText, renderValue, lookup } from "./template.js";
import { backoffMs, parseRetryAfter, MAX_DELAY_MS } from "./retry.js";
import { nextRun, validateCron } from "./schedule.js";

const trigger = { id: "t", type: "trigger.webhook", position: { x: 0, y: 0 }, data: {} };
const cond = { id: "c", type: "condition", data: { left: "{{trigger.body.valor}}", operator: "gt", right: "100" } };
const notify = (id: string) => ({ id, type: "notify.discord", data: { message: "oi" } });

test("fluxo válido: devolve a ordem de execução com o gatilho na frente e aplica os padrões", () => {
  const r = validateDefinition({
    nodes: [notify("n"), cond, trigger],
    edges: [{ id: "e1", source: "t", target: "c" }, { id: "e2", source: "c", target: "n", sourceHandle: "true" }],
  });
  assert.ok(r.ok);
  assert.deepEqual(r.order, ["t", "c", "n"]);
  const n = r.definition.nodes.find((x) => x.id === "n")!;
  assert.equal(n.type === "notify.discord" && n.data.attempts, 3); // padrão de tentativas
});

test("recusa ciclo, nó solto, dois gatilhos e aresta para o gatilho", () => {
  const ciclo = validateDefinition({
    nodes: [trigger, notify("a"), notify("b")],
    edges: [{ id: "1", source: "t", target: "a" }, { id: "2", source: "a", target: "b" }, { id: "3", source: "b", target: "a" }],
  });
  assert.ok(!ciclo.ok);
  assert.match(ciclo.problems[0].message, /ciclo/);

  const solto = validateDefinition({ nodes: [trigger, notify("a")], edges: [] });
  assert.ok(!solto.ok);
  assert.deepEqual(solto.problems, [{ nodeId: "a", message: "nó solto: não está ligado ao gatilho" }]);

  const dois = validateDefinition({ nodes: [trigger, { ...trigger, id: "t2" }], edges: [] });
  assert.ok(!dois.ok && dois.problems.some((p) => /exatamente um gatilho/.test(p.message)));

  const volta = validateDefinition({ nodes: [trigger, notify("a")], edges: [{ id: "1", source: "t", target: "a" }, { id: "2", source: "a", target: "t" }] });
  assert.ok(!volta.ok && volta.problems.some((p) => /gatilho/.test(p.message)));
});

test("condição exige saída sim/não; outros nós não podem ter saída", () => {
  const semSaida = validateDefinition({ nodes: [trigger, cond, notify("n")], edges: [{ id: "1", source: "t", target: "c" }, { id: "2", source: "c", target: "n" }] });
  assert.ok(!semSaida.ok && semSaida.problems[0].nodeId === "c");
  const saidaErrada = validateDefinition({ nodes: [trigger, notify("n")], edges: [{ id: "1", source: "t", target: "n", sourceHandle: "true" }] });
  assert.ok(!saidaErrada.ok);
});

test("formato inválido aponta o nó com problema", () => {
  const r = validateDefinition({
    nodes: [trigger, { id: "h", type: "http", data: { url: "x", timeoutMs: 999_999 } }],
    edges: [{ id: "1", source: "t", target: "h" }],
  });
  assert.ok(!r.ok);
  assert.equal(r.problems[0].nodeId, "h");
  assert.ok(!validateDefinition({ nodes: [{ ...trigger, type: "trigger.desconhecido" }], edges: [] }).ok);
  assert.ok(!validateDefinition(null).ok);
  assert.ok(!validateDefinition({ nodes: Array.from({ length: 31 }, (_, i) => notify(`n${i}`)), edges: [] }).ok);
});

test("agendamento: cron e fuso validados, intervalo mínimo de 5 minutos", () => {
  const sched = (cron: string, timezone = "America/Sao_Paulo") =>
    validateDefinition({ nodes: [{ id: "t", type: "trigger.schedule", data: { cron, timezone } }], edges: [] });
  assert.ok(sched("0 9 * * 1-5").ok);
  assert.ok(sched("*/5 * * * *").ok);
  assert.ok(!sched("*/2 * * * *").ok);
  assert.ok(!sched("0 9 * * *", "Marte/Olympus").ok);
  assert.ok(!sched("isso não é cron").ok);
  assert.equal(validateCron("0 9 * * 1-5", "America/Sao_Paulo"), null);
});

test("próxima execução respeita o fuso", () => {
  // 9h em São Paulo (UTC-3) = 12h UTC
  const next = nextRun("0 9 * * *", "America/Sao_Paulo", new Date("2026-10-12T10:00:00Z"));
  assert.equal(next.toISOString(), "2026-10-12T12:00:00.000Z");
  const depois = nextRun("0 9 * * *", "America/Sao_Paulo", new Date("2026-10-12T12:00:00Z"));
  assert.equal(depois.toISOString(), "2026-10-13T12:00:00.000Z");
});

test("templates: caminho, tipo preservado, texto e JSON sem injeção", () => {
  const ctx = { trigger: { body: { valor: 150, nome: 'Ana "A"', itens: [{ id: 7 }] } }, steps: {} };
  assert.equal(lookup(ctx, "trigger.body.itens.0.id"), 7);
  assert.equal(lookup(ctx, "trigger.body.nada.aqui"), undefined);
  assert.equal(lookup(ctx, "trigger.constructor"), undefined); // não sobe no protótipo
  assert.equal(renderValue("{{ trigger.body.valor }}", ctx), 150);
  assert.equal(renderText("Pedido de {{trigger.body.nome}}: R$ {{trigger.body.valor}}", ctx), 'Pedido de Ana "A": R$ 150');
  assert.equal(renderText("{{trigger.body.itens}}", ctx), '[{"id":7}]');
  assert.equal(renderText("{{nao.existe}}!", ctx), "!");
  // a aspa do nome não quebra o JSON: a variável é resolvida dentro da string, depois do parse
  assert.deepEqual(renderJson({ cliente: "{{trigger.body.nome}}", total: "{{trigger.body.valor}}", fixo: [1, "x"] }, ctx),
    { cliente: 'Ana "A"', total: 150, fixo: [1, "x"] });
});

test("condições: número como número, texto, contém e existe", () => {
  assert.equal(evaluate(150, "gt", "100"), true);
  assert.equal(evaluate("10", "gt", "9"), true); // como texto daria falso
  assert.equal(evaluate("abc", "gt", "1"), false); // ordem com não-número é falso
  assert.equal(evaluate("pago", "eq", "pago"), true);
  assert.equal(evaluate(1, "eq", "1.0"), true);
  assert.equal(evaluate("pago", "neq", "pendente"), true);
  assert.equal(evaluate("erro grave", "contains", "grave"), true);
  assert.equal(evaluate(["a", "b"], "contains", "b"), true);
  assert.equal(evaluate(["a", "b"], "not_contains", "c"), true);
  assert.equal(evaluate(undefined, "exists", ""), false);
  assert.equal(evaluate("", "not_exists", ""), true);
  assert.equal(evaluate(0, "exists", ""), true);
  assert.equal(evaluate(5, "lte", "5"), true);
});

test("backoff exponencial com jitter, teto de 10 min e Retry-After respeitado", () => {
  assert.equal(backoffMs(1, () => 0), 5_000);
  assert.equal(backoffMs(1, () => 1), 10_000);
  assert.equal(backoffMs(3, () => 1), 40_000);
  assert.equal(backoffMs(30, () => 1), MAX_DELAY_MS);
  assert.equal(backoffMs(1, () => 0, 120_000), 120_000);
  assert.equal(backoffMs(1, () => 0, 99 * 60_000), MAX_DELAY_MS);
  const now = new Date("2026-10-12T12:00:00Z");
  assert.equal(parseRetryAfter("30", now), 30_000);
  assert.equal(parseRetryAfter("Mon, 12 Oct 2026 12:01:00 GMT", now), 60_000);
  assert.equal(parseRetryAfter("lixo", now), undefined);
  assert.equal(parseRetryAfter(null, now), undefined);
});
