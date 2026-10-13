import { Router } from "express";
import { z } from "zod";
import { asUser } from "../../db/pool.js";
import { encrypt } from "../../security/secrets.js";
import { HttpError, notFound, parse } from "../errors.js";
import { idParam, need } from "../workspace-access.js";

export const MAX_CREDENTIALS = 20;

/**
 * O segredo de cada tipo é validado no formato do serviço: a credencial do Discord só aceita URL de
 * webhook do Discord, então não vira um jeito de mandar o motor chamar um endereço qualquer.
 */
const secretSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("discord_webhook"),
    url: z.string().regex(/^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/, "URL de webhook do Discord inválida"),
  }),
  z.object({
    kind: z.literal("slack_webhook"),
    url: z.string().regex(/^https:\/\/hooks\.slack\.com\/(?:services|triggers)\/[\w/-]+$/, "URL de webhook do Slack inválida"),
  }),
  z.object({
    kind: z.literal("telegram_bot"),
    token: z.string().regex(/^\d{5,15}:[A-Za-z0-9_-]{30,50}$/, "token do bot inválido (o @BotFather entrega no formato 123456:ABC...)"),
  }),
  z.object({
    kind: z.literal("http_header"),
    header: z.string().regex(/^[A-Za-z0-9-]{1,64}$/, "nome de cabeçalho inválido"),
    value: z.string().min(1).max(2000),
  }),
  z.object({
    kind: z.literal("anthropic_key"),
    key: z.string().trim().regex(/^sk-ant-[A-Za-z0-9_-]{20,300}$/, "chave da Anthropic inválida (começa com sk-ant-)"),
  }),
  z.object({
    kind: z.literal("gemini_key"),
    key: z.string().trim().regex(/^[A-Za-z0-9_-]{30,200}$/, "chave do Gemini inválida (copie do Google AI Studio)"),
  }),
]);

type Secret = z.infer<typeof secretSchema>;
const toStored = (s: Secret) => {
  switch (s.kind) {
    case "http_header": return JSON.stringify({ name: s.header, value: s.value });
    case "telegram_bot": return s.token;
    case "anthropic_key":
    case "gemini_key": return s.key;
    default: return s.url;
  }
};

const name = z.string().trim().min(1).max(80);

/** /api/workspaces/:ws/credentials. O segredo entra e nunca mais sai (nem para o owner). */
export function credentialsRouter() {
  const r = Router({ mergeParams: true });

  r.get("/", async (_req, res) => {
    const rows = await asUser(res.locals.userId, async (c) => (await c.query(
      `SELECT c.id, c.kind, c.name, u.name AS "createdBy", c.created_at AS "createdAt", c.updated_at AS "updatedAt"
         FROM credentials c LEFT JOIN users u ON u.id = c.created_by
        WHERE c.workspace_id = $1 AND c.deleted_at IS NULL ORDER BY c.name`,
      [res.locals.workspaceId],
    )).rows);
    res.json(rows);
  });

  r.post("/", need("editor"), async (req, res) => {
    const p = parse(z.object({ name, secret: secretSchema }), req.body);
    const row = await asUser(res.locals.userId, async (c) => {
      const { rows: [{ n }] } = await c.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM credentials WHERE workspace_id = $1 AND deleted_at IS NULL", [res.locals.workspaceId]);
      if (n >= MAX_CREDENTIALS) throw new HttpError(409, `Limite de ${MAX_CREDENTIALS} credenciais por workspace`);
      return (await c.query(
        `INSERT INTO credentials (workspace_id, kind, name, secret_encrypted, created_by) VALUES ($1, $2, $3, $4, app_user_id())
         RETURNING id, kind, name, created_at AS "createdAt"`,
        [res.locals.workspaceId, p.secret.kind, p.name, encrypt(toStored(p.secret))],
      )).rows[0];
    });
    res.status(201).json(row);
  });

  /** Renomear e/ou trocar o segredo (o tipo não muda: os fluxos que usam a credencial esperam esse tipo). */
  r.patch("/:id", need("editor"), async (req, res) => {
    const id = idParam(req, "id", "Credencial não encontrada");
    const p = parse(z.object({ name: name.optional(), secret: secretSchema.optional() }).refine((v) => v.name || v.secret, "nada para alterar"), req.body);
    const row = await asUser(res.locals.userId, async (c) => {
      const cur = (await c.query<{ kind: string }>(
        "SELECT kind FROM credentials WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL", [id, res.locals.workspaceId])).rows[0];
      if (!cur) throw notFound("Credencial não encontrada");
      if (p.secret && p.secret.kind !== cur.kind) throw new HttpError(400, "O tipo da credencial não pode mudar");
      // dois UPDATEs: "COALESCE(novo, secret_encrypted)" precisaria LER a coluna do segredo, que motor_app não pode
      if (p.secret) await c.query("UPDATE credentials SET secret_encrypted = $2 WHERE id = $1", [id, encrypt(toStored(p.secret))]);
      if (p.name) await c.query("UPDATE credentials SET name = $2 WHERE id = $1", [id, p.name]);
      return (await c.query(`SELECT id, kind, name, updated_at AS "updatedAt" FROM credentials WHERE id = $1`, [id])).rows[0];
    });
    res.json(row);
  });

  /** Soft delete: fluxos que ainda usam a credencial passam a falhar com mensagem clara (sem retry). */
  r.delete("/:id", need("editor"), async (req, res) => {
    const id = idParam(req, "id", "Credencial não encontrada");
    const r2 = await asUser(res.locals.userId, (c) => c.query(
      "UPDATE credentials SET deleted_at = now() WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL", [id, res.locals.workspaceId]));
    if (!r2.rowCount) throw notFound("Credencial não encontrada");
    res.status(204).end();
  });

  return r;
}
