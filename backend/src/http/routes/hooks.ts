import express, { Router } from "express";
import { asSystem } from "../../db/pool.js";
import { enqueue } from "../../engine/queue.js";
import { sha256 } from "../../security/secrets.js";
import { HttpError } from "../errors.js";
import type { Limits } from "../limits.js";

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/**
 * POST /hooks/:token: porta de entrada pública dos sistemas de fora. Fica fora de /api: não recebe
 * cookie de sessão nem tem CORS (quem chama é servidor, não navegador).
 *
 * Respostas (de quem é a falha):
 *  - 202: aceito na fila (o fluxo roda depois; a resposta não espera)
 *  - 200: reenvio com a mesma Idempotency-Key → devolve a execução que já existe
 *  - 404: token errado OU fluxo desligado (não diz qual: não revela que o fluxo existe)
 *  - 400/413: JSON inválido / corpo acima de 256 KB · 429: rate limit ou cota do dia (com Retry-After)
 */
export function hooksRouter(l: Limits, onEnqueue: () => void) {
  const r = Router();
  r.post(
    "/:token",
    l.hookIp,
    l.hookToken,
    express.json({ limit: "256kb", type: ["application/json", "application/*+json"] }),
    express.urlencoded({ limit: "256kb", extended: false }),
    async (req, res) => {
      const token = String(req.params.token);
      if (!TOKEN.test(token)) throw new HttpError(404, "Webhook não encontrado ou desativado");
      const key = req.get("idempotency-key")?.trim();
      if (key !== undefined && (key.length === 0 || key.length > 200)) throw new HttpError(400, "Idempotency-Key deve ter de 1 a 200 caracteres");

      const result = await asSystem(async (c) => {
        const t = (await c.query<{ workspace_id: string; workflow_id: string; published_version_id: string }>(
          `SELECT t.workspace_id, t.workflow_id, w.published_version_id
             FROM workflow_triggers t
             JOIN workflows w ON w.id = t.workflow_id
             JOIN workspaces ws ON ws.id = t.workspace_id
            WHERE t.webhook_token_hash = $1 AND t.kind = 'webhook'
              AND w.is_active AND w.deleted_at IS NULL AND ws.deleted_at IS NULL`,
          [sha256(token)],
        )).rows[0];
        if (!t) return null;
        return enqueue(c, {
          workspaceId: t.workspace_id,
          workflowId: t.workflow_id,
          versionId: t.published_version_id,
          trigger: "webhook",
          input: {
            body: req.body ?? {},
            query: req.query,
            headers: { "content-type": req.get("content-type") ?? null, "user-agent": req.get("user-agent") ?? null },
            receivedAt: new Date().toISOString(),
          },
          idempotencyKey: key ? `hook:${key}` : null,
        });
      });
      if (!result) throw new HttpError(404, "Webhook não encontrado ou desativado");
      if (!result.duplicate) onEnqueue();
      res.status(result.duplicate ? 200 : 202).json({ executionId: result.id, duplicate: result.duplicate });
    },
  );
  r.all("/:token", (_req, res) => void res.status(405).set("Allow", "POST").json({ error: "Use POST" }));
  return r;
}
