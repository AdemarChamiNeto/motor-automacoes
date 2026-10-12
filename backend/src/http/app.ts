import fs from "node:fs";
import path from "node:path";
import express from "express";
import compression from "compression";
import helmet from "helmet";
import swaggerUi from "swagger-ui-express";
import { errorHandler } from "./errors.js";
import { createLimits } from "./limits.js";
import { openapi } from "./openapi.js";
import { authRouter } from "./routes/auth.js";
import { credentialsRouter } from "./routes/credentials.js";
import { hooksRouter } from "./routes/hooks.js";
import { workflowsRouter } from "./routes/workflows.js";
import { invitesRouter, workspacesRouter } from "./routes/workspaces.js";
import { loadWorkspace } from "./workspace-access.js";
import { requireAuth } from "./session.js";

export type AppOptions = {
  /** Chamado quando o próprio processo enfileira algo: acorda o worker sem esperar o polling. */
  onEnqueue?: () => void;
  staticDir?: string;
};

/** Monta o app sem abrir porta: os testes sobem em memória. */
export function createApp(opts: AppOptions = {}) {
  const onEnqueue = opts.onEnqueue ?? (() => {});
  const app = express();
  app.set("trust proxy", 1); // atrás do proxy do Render: o IP real vem do X-Forwarded-For
  app.disable("x-powered-by");

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        "script-src": ["'self'", "https://www.googletagmanager.com", "https://www.clarity.ms", "https://*.clarity.ms"],
        "connect-src": ["'self'", "https://*.google-analytics.com", "https://*.analytics.google.com", "https://*.clarity.ms"],
        "img-src": ["'self'", "data:", "https://*.google-analytics.com", "https://*.googletagmanager.com", "https://*.clarity.ms"],
      },
    },
  }));
  app.use(compression());

  const limits = createLimits();

  // webhook público antes do parser global: tem limite de corpo e rate limit próprios
  app.use("/hooks", hooksRouter(limits, onEnqueue));

  // API do app: sem CORS (front e API no mesmo domínio), corpo de até 100 KB
  app.use("/api", express.json({ limit: "100kb" }), limits.read, limits.write);
  app.get("/api/health", (_req, res) => void res.json({ ok: true }));
  app.get("/api/docs.json", (_req, res) => void res.json(openapi));
  app.use("/api/docs", swaggerUi.serve, swaggerUi.setup(openapi, { customSiteTitle: "Motor de Automações — API" }));
  app.use("/api/auth", authRouter(limits));
  app.use("/api/invites", invitesRouter(limits));
  app.use("/api/workspaces/:ws/credentials", requireAuth, loadWorkspace, credentialsRouter());
  app.use("/api/workspaces/:ws/workflows", requireAuth, loadWorkspace, workflowsRouter(onEnqueue));
  app.use("/api/workspaces", workspacesRouter());
  app.use("/api", (_req, res) => void res.status(404).json({ error: "Rota não encontrada" }));

  // Em produção (serviço único) a API também entrega o front compilado (SPA).
  const staticDir = opts.staticDir;
  if (staticDir && fs.existsSync(path.join(staticDir, "index.html"))) {
    app.use(express.static(staticDir, { maxAge: "1h", index: false }));
    const index = path.resolve(staticDir, "index.html");
    // rotas do front: index.html; arquivo com extensão que não existe: 404 de verdade
    app.get(/^\/(?!.*\.[a-z0-9]+$).*/i, (_req, res) => res.sendFile(index));
  }

  app.use(errorHandler);
  return app;
}
