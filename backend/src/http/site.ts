import fs from "node:fs";
import path from "node:path";
import type { Express } from "express";
import express from "express";
import { envVar } from "../config/env.js";

/**
 * Entrega o front compilado (SPA) com o que precisa de URL absoluta preenchido na hora:
 * canonical, Open Graph, JSON-LD, robots, sitemap e llms.txt usam o endereço real do deploy
 * (PUBLIC_URL, que no Render vem sozinho de RENDER_EXTERNAL_URL).
 *
 * Só as rotas que o front conhece recebem o index.html; qualquer outro caminho é 404 de verdade
 * (buscador não indexa página "não encontrada" com status 200).
 */
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const APP_ROUTES = new RegExp(`^/(?:entrar|conta|convite|w/${UUID}(?:/credenciais|/membros|/fluxos/${UUID}(?:/execucoes)?)?)?/?$`);
/** Páginas públicas (as outras levam noindex). */
const PUBLIC_ROUTES = new Set(["/", "/entrar"]);

const base = () => envVar("PUBLIC_URL").replace(/\/$/, "");

export function serveSite(app: Express, staticDir: string) {
  const file = (name: string) => path.resolve(staticDir, name);
  if (!fs.existsSync(file("index.html"))) return;
  const read = (name: string) => fs.readFileSync(file(name), "utf8").replaceAll("__PUBLIC_URL__", base());
  const index = read("index.html");
  const privacy = fs.existsSync(file("privacidade.html")) ? read("privacidade.html") : null;
  const notFound = fs.existsSync(file("404.html")) ? read("404.html") : "<h1>Página não encontrada</h1>";

  app.get("/robots.txt", (_req, res) => {
    res.type("text/plain").send(
      ["User-agent: *", "Allow: /", "Allow: /api/docs", "Disallow: /api/", "Disallow: /hooks/", "Disallow: /w/", "Disallow: /conta", "Disallow: /convite", "",
        `Sitemap: ${base()}/sitemap.xml`, ""].join("\n"),
    );
  });

  app.get("/sitemap.xml", (_req, res) => {
    const urls = ["/entrar", "/privacidade.html", "/api/docs/"]
      .map((p) => `  <url><loc>${base()}${p}</loc></url>`).join("\n");
    res.type("application/xml").send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`);
  });

  app.get("/llms.txt", (_req, res) => {
    res.type("text/plain").send(`# Motor de Automações

> Fluxos de automação visuais (webhook ou agendamento → condição → chamada HTTP → Discord, Slack ou Telegram) executados de verdade por uma fila no PostgreSQL, com novas tentativas automáticas e histórico de cada passo. Projeto de portfólio de Ademar C. Neto.

- [Entrar ou experimentar sem cadastro](${base()}/entrar): conta de demonstração de 24 h com fluxos de exemplo
- [Documentação da API (OpenAPI)](${base()}/api/docs/)
- [Privacidade](${base()}/privacidade.html)
- [Código-fonte](https://github.com/AdemarChamiNeto/motor-automacoes)
`);
  });

  if (privacy) app.get("/privacidade.html", (_req, res) => void res.type("html").send(privacy));
  // arquivos do build têm hash no nome: podem ficar em cache por 1 ano (versão nova = nome novo)
  app.use("/assets", express.static(path.join(staticDir, "assets"), { maxAge: "365d", immutable: true, fallthrough: false }));
  app.use(express.static(staticDir, { maxAge: "1h", index: false }));

  app.use((req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    if (!APP_ROUTES.test(req.path)) return void res.status(404).type("html").send(notFound);
    const html = PUBLIC_ROUTES.has(req.path) ? index : index.replace("</head>", '<meta name="robots" content="noindex" />\n</head>');
    res.type("html").set("Cache-Control", "no-cache").send(html);
  });
}
