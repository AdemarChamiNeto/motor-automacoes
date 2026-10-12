import pg from "pg";

export type Db = pg.PoolClient;

let pool: pg.Pool | null = null;

/** Pool criado na primeira consulta (os testes trocam o DATABASE_URL antes de importar nada). */
export function getPool(): pg.Pool {
  pool ??= new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: Number(process.env.DB_POOL_MAX ?? 10),
    connectionTimeoutMillis: 5_000,
    // nenhuma consulta presa segura uma conexão para sempre (pergunta 3: timeout no banco também)
    statement_timeout: 10_000,
    idle_in_transaction_session_timeout: 30_000,
  });
  return pool;
}

export async function closePool() {
  await pool?.end();
  pool = null;
}

async function tx<T>(setup: (c: Db) => Promise<unknown>, fn: (c: Db) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await setup(client);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Transação em nome de um usuário logado: papel motor_app + app.user_id. O RLS do Postgres só
 * deixa ver e mexer no que é dos workspaces dele, mesmo que a consulta esqueça o filtro.
 * SET LOCAL / set_config(..., true) valem só até o fim da transação: a conexão volta limpa ao pool.
 */
export function asUser<T>(userId: string, fn: (c: Db) => Promise<T>): Promise<T> {
  return tx(async (c) => {
    await c.query("SET LOCAL ROLE motor_app");
    await c.query("SELECT set_config('app.user_id', $1, true)", [userId]);
  }, fn);
}

/**
 * Transação de sistema (motor_system): login, cadastro, chegada de webhook, worker, agendador e
 * limpeza. Não tem usuário, então o isolamento fica no código; por isso cada uso é curto e explícito.
 */
export function asSystem<T>(fn: (c: Db) => Promise<T>): Promise<T> {
  return tx((c) => c.query("SET LOCAL ROLE motor_system"), fn);
}

/** Códigos de erro do Postgres que a aplicação trata. */
export const PG = {
  uniqueViolation: "23505",
  checkViolation: "23514",
  foreignKeyViolation: "23503",
  insufficientPrivilege: "42501",
} as const;

export const pgCode = (err: unknown): string | undefined =>
  typeof err === "object" && err !== null && "code" in err ? String((err as { code: unknown }).code) : undefined;
