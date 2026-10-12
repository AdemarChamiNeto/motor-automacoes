import { env } from "./config/env.js";
import { closePool } from "./db/pool.js";
import { migrate } from "./db/migrate.js";
import { cleanup, runDueSchedules } from "./engine/queue.js";
import { Worker } from "./engine/worker.js";
import { createApp } from "./http/app.js";
import { purgeExpiredDemos } from "./services/maintenance.js";

env(); // falha logo na subida se faltar variável obrigatória
await migrate();

/**
 * Um processo só (plano grátis do Render): API + worker + agendador + limpeza.
 * A fila no banco já permite separar o worker em outro serviço sem mudar código.
 */
const worker = new Worker();
worker.start();

const every = (ms: number, name: string, fn: () => Promise<unknown>) =>
  setInterval(() => void fn().catch((e) => console.error(`[${name}]`, e)), ms);
const timers = [
  every(10_000, "agendador", async () => {
    const r = await runDueSchedules();
    if (r.enqueued) worker.wake();
  }),
  every(60 * 60_000, "limpeza", async () => {
    const [h, d] = await Promise.all([cleanup(), purgeExpiredDemos()]);
    if (h.executions || d.users) console.log(`[limpeza] ${h.executions} execuções antigas, ${d.users} contas demo vencidas`);
  }),
];

const port = Number(process.env.PORT ?? 3002);
const server = createApp({ onEnqueue: () => worker.wake(), staticDir: process.env.STATIC_DIR }).listen(port, () =>
  console.log(`Motor de automações em http://localhost:${port} (API em /api, documentação em /api/docs)`),
);

/** Deploy/parada: para de aceitar pedidos, deixa o worker terminar o passo atual e fecha o banco. */
async function shutdown(signal: string) {
  console.log(`${signal}: encerrando...`);
  timers.forEach(clearInterval);
  server.close();
  await worker.stop();
  await closePool();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
