import { asSystem } from "../db/pool.js";

/**
 * Contas de "experimentar sem cadastro" vencidas: apaga os workspaces que elas criaram (e tudo
 * dentro, em cascata) e depois a conta. Workspace que tem outro owner de verdade fica.
 */
export function purgeExpiredDemos(): Promise<{ users: number; workspaces: number }> {
  return asSystem(async (c) => {
    const ws = await c.query(
      `DELETE FROM workspaces w
        WHERE EXISTS (SELECT 1 FROM workspace_members m JOIN users u ON u.id = m.user_id
                       WHERE m.workspace_id = w.id AND m.role = 'owner' AND u.demo_expires_at < now())
          AND NOT EXISTS (SELECT 1 FROM workspace_members m JOIN users u ON u.id = m.user_id
                           WHERE m.workspace_id = w.id AND m.role = 'owner' AND (u.demo_expires_at IS NULL OR u.demo_expires_at >= now()))`,
    );
    const users = await c.query("DELETE FROM users WHERE demo_expires_at < now()");
    return { users: users.rowCount ?? 0, workspaces: ws.rowCount ?? 0 };
  });
}
