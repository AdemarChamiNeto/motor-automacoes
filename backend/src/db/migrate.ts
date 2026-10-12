import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getPool } from "./pool.js";

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");
/** Número fixo para o advisory lock: duas instâncias subindo juntas não migram ao mesmo tempo. */
const LOCK_ID = 7_340_001;

/**
 * Aplica, em ordem, os arquivos de migrations/ que ainda não rodaram. Cada arquivo roda numa
 * transação: se falhar no meio, nada dele fica aplicado. Roda como o dono das tabelas.
 */
export async function migrate(log: (msg: string) => void = console.log): Promise<string[]> {
  const client = await getPool().connect();
  const applied: string[] = [];
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_ID]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const done = new Set((await client.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
    const files = fs.readdirSync(DIR).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = fs.readFileSync(path.join(DIR, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Migração ${file} falhou: ${(err as Error).message}`);
      }
      applied.push(file);
      log(`migração aplicada: ${file}`);
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_ID]).catch(() => {});
    client.release();
  }
  return applied;
}
