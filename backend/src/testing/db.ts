/**
 * Apoio dos testes de integração: banco de teste real (docker compose up -d db, ou o serviço do CI).
 * Fixtures são gravadas como dono das tabelas (sem RLS); o código testado usa asUser/asSystem.
 */
process.env.DATABASE_URL ??= "postgres://motor:motor-dev@localhost:5433/motor_test";
process.env.ENCRYPTION_KEY ??= "1".repeat(64);
process.env.JWT_SECRET ??= "segredo-dos-testes-com-tamanho-suficiente-123";

const { getPool } = await import("../db/pool.js");
const { migrate } = await import("../db/migrate.js");

let migrated = false;

/** Banco zerado: na primeira vez recria o schema e roda as migrações; depois só esvazia as tabelas. */
export async function resetDb() {
  const pool = getPool();
  if (!migrated) {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await migrate(() => {});
    migrated = true;
    return;
  }
  const { rows } = await pool.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'",
  );
  await pool.query(`TRUNCATE ${rows.map((r) => `"${r.tablename}"`).join(", ")} CASCADE`);
}

export const owner = () => getPool();

export type Role = "owner" | "editor" | "viewer";

export async function createUser(name: string, email = `${name.toLowerCase()}@exemplo.com`): Promise<string> {
  const { rows } = await owner().query<{ id: string }>("INSERT INTO users (name, email) VALUES ($1, $2) RETURNING id", [name, email]);
  return rows[0].id;
}

export async function createWorkspace(name: string, members: [string, Role][]): Promise<string> {
  const { rows } = await owner().query<{ id: string }>("INSERT INTO workspaces (name) VALUES ($1) RETURNING id", [name]);
  for (const [userId, role] of members) {
    await owner().query("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)", [rows[0].id, userId, role]);
  }
  return rows[0].id;
}

/** Cria um fluxo já publicado (versão 1) e ativo. */
export async function createPublishedWorkflow(workspaceId: string, definition: unknown, name = "Fluxo"): Promise<{ workflowId: string; versionId: string }> {
  const c = await owner().connect();
  try {
    await c.query("BEGIN");
    const w = await c.query<{ id: string }>(
      "INSERT INTO workflows (workspace_id, name, draft) VALUES ($1, $2, $3) RETURNING id",
      [workspaceId, name, JSON.stringify(definition)],
    );
    const v = await c.query<{ id: string }>(
      "INSERT INTO workflow_versions (workspace_id, workflow_id, version, definition) VALUES ($1, $2, 1, $3) RETURNING id",
      [workspaceId, w.rows[0].id, JSON.stringify(definition)],
    );
    await c.query("UPDATE workflows SET published_version_id = $2, is_active = true WHERE id = $1", [w.rows[0].id, v.rows[0].id]);
    await c.query("COMMIT");
    return { workflowId: w.rows[0].id, versionId: v.rows[0].id };
  } catch (err) {
    await c.query("ROLLBACK");
    throw err;
  } finally {
    c.release();
  }
}
