/**
 * Especificação OpenAPI 3, servida em /api/docs (Swagger UI) e /api/docs.json.
 * Mantida à mão junto das rotas; o teste de integração confere que toda rota real está aqui.
 */
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: object) => ({ "application/json": { schema } });
const body = (schema: object) => ({ required: true, content: json(schema) });
const ok = (description: string, schema?: object) => ({ description, ...(schema ? { content: json(schema) } : {}) });
const err = (description: string) => ({ description, content: json(ref("Error")) });

const common = {
  401: err("Sem sessão"),
  429: err("Rate limit (com Retry-After)"),
};
const inWs = { ...common, 403: err("Papel não permite"), 404: err("Workspace (ou recurso) não encontrado, ou você não é membro") };

const wsParam = { name: "ws", in: "path", required: true, schema: { type: "string", format: "uuid" } };
const idParam = (name = "id") => ({ name, in: "path", required: true, schema: { type: "string", format: "uuid" } });

type Op = { tags: string[]; summary: string; description?: string; parameters?: object[]; requestBody?: object; responses: Record<string, object>; security?: object[] };
const op = (tags: string, summary: string, responses: Record<string, object>, extra: Partial<Op> = {}): Op => ({ tags: [tags], summary, responses, ...extra });

export const openapi = {
  openapi: "3.0.3",
  info: {
    title: "Motor de Automações — API",
    version: "1.0.0",
    description:
      "Fluxos visuais (gatilho → condição → HTTP → notificação) executados por uma fila no PostgreSQL, com retries, agendamento e histórico.\n\n" +
      "**Como testar aqui:** `POST /auth/demo` cria uma conta temporária (24 h) já com fluxos de exemplo. A sessão fica num cookie httpOnly.\n\n" +
      "**Webhook:** cada fluxo publicado com gatilho de webhook tem uma URL própria `POST /hooks/{token}` (fora de `/api`).\n\n" +
      "Todas as rotas têm rate limit (429 com `Retry-After`). Erros no formato `{ error, details? }`.",
  },
  servers: [{ url: "/api" }],
  tags: [
    { name: "Auth" }, { name: "Workspaces" }, { name: "Convites" }, { name: "Credenciais" },
    { name: "Fluxos" }, { name: "Execuções" }, { name: "Webhook" },
  ],
  components: {
    securitySchemes: { cookie: { type: "apiKey", in: "cookie", name: "motor_session" } },
    schemas: {
      Error: {
        type: "object",
        properties: {
          error: { type: "string", example: "Dados inválidos" },
          details: { type: "array", items: { type: "object" }, description: "Campos inválidos ou problemas do fluxo (nodeId + message)" },
        },
      },
      User: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" }, name: { type: "string" }, email: { type: "string" },
          twoFactorEnabled: { type: "boolean" }, demoExpiresAt: { type: "string", format: "date-time", nullable: true },
        },
      },
      Definition: {
        type: "object",
        description: "Nós e arestas (formato do React Flow). Tipos: trigger.webhook, trigger.schedule, trigger.manual, condition, http, notify.discord, notify.slack, notify.telegram. Variáveis: {{trigger.body.x}}, {{steps.<nó>.body.y}}.",
        properties: { nodes: { type: "array", items: { type: "object" } }, edges: { type: "array", items: { type: "object" } } },
      },
      Execution: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          status: { type: "string", enum: ["queued", "running", "succeeded", "failed", "canceled"] },
          trigger: { type: "string", enum: ["webhook", "schedule", "manual"] },
          attempt: { type: "integer" }, error: { type: "string", nullable: true }, version: { type: "integer" },
          createdAt: { type: "string", format: "date-time" },
        },
      },
    },
  },
  security: [{ cookie: [] }],
  paths: {
    "/health": { get: op("Auth", "Saúde do serviço", { 200: ok("ok") }, { security: [] }) },
    "/auth/register": {
      post: op("Auth", "Cadastro (cria o workspace pessoal com fluxos de exemplo)", { 201: ok("Criado", { type: "object", properties: { user: ref("User") } }), 400: err("Dados inválidos"), 409: err("E-mail já cadastrado"), 429: common[429] }, {
        security: [], requestBody: body({ type: "object", required: ["name", "email", "password"], properties: { name: { type: "string" }, email: { type: "string" }, password: { type: "string", minLength: 8 } } }),
      }),
    },
    "/auth/demo": { post: op("Auth", "Experimentar sem cadastro (conta de 24 h)", { 201: ok("Sessão criada"), 429: common[429] }, { security: [] }) },
    "/auth/login": {
      post: op("Auth", "Login (com 2FA ativo responde twoFactorRequired)", { 200: ok("Sessão criada ou 2FA pendente"), 401: err("E-mail ou senha incorretos"), 429: common[429] }, {
        security: [], requestBody: body({ type: "object", properties: { email: { type: "string" }, password: { type: "string" } } }),
      }),
    },
    "/auth/login/2fa": { post: op("Auth", "Segundo passo do login (código do app ou de recuperação)", { 200: ok("Sessão criada"), 401: err("Código inválido") }, { security: [], requestBody: body({ type: "object", properties: { code: { type: "string" } } }) }) },
    "/auth/logout": { post: op("Auth", "Sair", { 204: ok("Sessão apagada") }) },
    "/auth/me": { get: op("Auth", "Usuário da sessão", { 200: ok("Usuário", ref("User")), ...common }) },
    "/auth/2fa/setup": { post: op("Auth", "Gera o segredo e a URL do QR code", { 200: ok("Segredo"), 409: err("2FA já ativo"), ...common }) },
    "/auth/2fa/enable": { post: op("Auth", "Ativa o 2FA com o primeiro código; devolve os códigos de recuperação", { 200: ok("Códigos de recuperação"), 400: err("Código inválido"), ...common }, { requestBody: body({ type: "object", properties: { code: { type: "string" } } }) }) },
    "/auth/2fa/disable": { post: op("Auth", "Desativa o 2FA (pede senha e código)", { ...common, 204: ok("Desativado"), 401: err("Senha ou código incorretos") }, { requestBody: body({ type: "object", properties: { password: { type: "string" }, code: { type: "string" } } }) }) },

    "/workspaces": {
      get: op("Workspaces", "Meus workspaces, com o meu papel", { 200: ok("Lista"), ...common }),
      post: op("Workspaces", "Criar workspace (vira owner; até 5 por conta)", { 201: ok("Criado"), 409: err("Limite atingido"), ...common }, { requestBody: body({ type: "object", properties: { name: { type: "string" } } }) }),
    },
    "/workspaces/{ws}": {
      get: op("Workspaces", "Dados do workspace", { 200: ok("Workspace"), ...inWs }, { parameters: [wsParam] }),
      patch: op("Workspaces", "Renomear (owner)", { 200: ok("Renomeado"), ...inWs }, { parameters: [wsParam], requestBody: body({ type: "object", properties: { name: { type: "string" } } }) }),
      delete: op("Workspaces", "Apagar (owner; soft delete)", { 204: ok("Apagado"), ...inWs }, { parameters: [wsParam] }),
    },
    "/workspaces/{ws}/members": { get: op("Workspaces", "Membros", { 200: ok("Lista"), ...inWs }, { parameters: [wsParam] }) },
    "/workspaces/{ws}/members/{userId}": {
      patch: op("Workspaces", "Mudar papel (owner)", { 200: ok("Alterado"), 409: err("O workspace precisa de pelo menos um owner"), ...inWs }, { parameters: [wsParam, idParam("userId")], requestBody: body({ type: "object", properties: { role: { type: "string", enum: ["viewer", "editor", "owner"] } } }) }),
      delete: op("Workspaces", "Remover membro (owner) ou sair (a própria conta)", { 204: ok("Removido"), 409: err("Último owner"), ...inWs }, { parameters: [wsParam, idParam("userId")] }),
    },
    "/workspaces/{ws}/invites": {
      get: op("Convites", "Convites pendentes (owner)", { 200: ok("Lista"), ...inWs }, { parameters: [wsParam] }),
      post: op("Convites", "Convidar por link (devolve o link uma vez) ou por e-mail", { 201: ok("Convite criado"), ...inWs }, { parameters: [wsParam], requestBody: body({ type: "object", properties: { role: { type: "string", enum: ["viewer", "editor"] }, email: { type: "string" } } }) }),
    },
    "/workspaces/{ws}/invites/{id}": { delete: op("Convites", "Revogar convite (owner)", { 204: ok("Revogado"), ...inWs }, { parameters: [wsParam, idParam()] }) },
    "/invites": { get: op("Convites", "Convites recebidos no meu e-mail", { 200: ok("Lista"), ...common }) },
    "/invites/{id}/accept": { post: op("Convites", "Aceitar convite por e-mail", { 200: ok("Entrou no workspace"), 404: err("Convite não encontrado ou vencido"), ...common }, { parameters: [idParam()] }) },
    "/invites/accept-link": { post: op("Convites", "Aceitar convite pelo link", { 200: ok("Entrou no workspace"), 404: err("Convite não encontrado, usado ou vencido"), ...common }, { requestBody: body({ type: "object", properties: { token: { type: "string" } } }) }) },

    "/workspaces/{ws}/credentials": {
      get: op("Credenciais", "Credenciais (nunca devolve o segredo)", { 200: ok("Lista"), ...inWs }, { parameters: [wsParam] }),
      post: op("Credenciais", "Criar credencial (editor)", { 201: ok("Criada"), 409: err("Nome repetido ou limite"), ...inWs }, {
        parameters: [wsParam],
        requestBody: body({ type: "object", properties: { name: { type: "string" }, secret: { type: "object", description: "{kind: discord_webhook|slack_webhook, url} · {kind: telegram_bot, token} · {kind: http_header, header, value} · {kind: anthropic_key|gemini_key, key}" } } }),
      }),
    },
    "/workspaces/{ws}/credentials/{id}": {
      patch: op("Credenciais", "Renomear ou trocar o segredo (editor)", { 200: ok("Alterada"), ...inWs }, { parameters: [wsParam, idParam()] }),
      delete: op("Credenciais", "Apagar (editor)", { 204: ok("Apagada"), ...inWs }, { parameters: [wsParam, idParam()] }),
    },

    "/workspaces/{ws}/workflows": {
      get: op("Fluxos", "Fluxos do workspace, com a última execução", { 200: ok("Lista"), ...inWs }, { parameters: [wsParam] }),
      post: op("Fluxos", "Criar fluxo (editor; até 20 por workspace)", { 201: ok("Criado"), 409: err("Nome repetido ou limite"), ...inWs }, { parameters: [wsParam], requestBody: body({ type: "object", properties: { name: { type: "string" }, description: { type: "string" }, draft: ref("Definition") } }) }),
    },
    "/workspaces/{ws}/workflows/{id}": {
      get: op("Fluxos", "Fluxo com rascunho, versão publicada e problemas do rascunho", { 200: ok("Fluxo"), ...inWs }, { parameters: [wsParam, idParam()] }),
      patch: op("Fluxos", "Salvar rascunho / renomear (editor)", { 200: ok("Salvo"), ...inWs }, { parameters: [wsParam, idParam()], requestBody: body({ type: "object", properties: { name: { type: "string" }, description: { type: "string" }, draft: ref("Definition") } }) }),
      delete: op("Fluxos", "Apagar (editor; soft delete, desliga gatilhos)", { 204: ok("Apagado"), ...inWs }, { parameters: [wsParam, idParam()] }),
    },
    "/workspaces/{ws}/workflows/{id}/publish": { post: op("Fluxos", "Publicar o rascunho como nova versão (devolve a URL do webhook uma vez)", { 200: ok("Publicado"), 422: err("O fluxo tem problemas (details: nodeId + message)"), ...inWs }, { parameters: [wsParam, idParam()] }) },
    "/workspaces/{ws}/workflows/{id}/activate": { post: op("Fluxos", "Ligar gatilhos (webhook/agendamento)", { 200: ok("Ativo"), 409: err("Não publicado"), ...inWs }, { parameters: [wsParam, idParam()] }) },
    "/workspaces/{ws}/workflows/{id}/deactivate": { post: op("Fluxos", "Desligar gatilhos", { 200: ok("Inativo"), ...inWs }, { parameters: [wsParam, idParam()] }) },
    "/workspaces/{ws}/workflows/{id}/webhook/rotate": { post: op("Fluxos", "Gerar nova URL de webhook (a antiga para na hora)", { 200: ok("Nova URL"), 409: err("Sem gatilho de webhook"), ...inWs }, { parameters: [wsParam, idParam()] }) },
    "/workspaces/{ws}/workflows/{id}/run": { post: op("Execuções", "Executar agora (versão publicada, com entrada de teste)", { ...inWs, 202: ok("Na fila"), 409: err("Não publicado"), 429: err("Rate limit ou cota diária do workspace") }, { parameters: [wsParam, idParam()], requestBody: { content: json({ type: "object", properties: { input: { type: "object" } } }) } }) },
    "/workspaces/{ws}/workflows/{id}/versions": { get: op("Fluxos", "Versões publicadas", { 200: ok("Lista"), ...inWs }, { parameters: [wsParam, idParam()] }) },
    "/workspaces/{ws}/workflows/{id}/executions": {
      get: op("Execuções", "Histórico (paginação por cursor)", { 200: ok("Página", { type: "object", properties: { items: { type: "array", items: ref("Execution") }, nextCursor: { type: "string", nullable: true } } }), ...inWs }, {
        parameters: [wsParam, idParam(),
          { name: "status", in: "query", schema: { type: "string", enum: ["queued", "running", "succeeded", "failed", "canceled"] } },
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 20 } },
          { name: "cursor", in: "query", schema: { type: "string" } }],
      }),
    },
    "/workspaces/{ws}/workflows/{id}/executions/{execId}": { get: op("Execuções", "Execução com os passos (entrada, saída, erro, duração)", { 200: ok("Execução"), ...inWs }, { parameters: [wsParam, idParam(), idParam("execId")] }) },
    "/workspaces/{ws}/workflows/{id}/executions/{execId}/cancel": { post: op("Execuções", "Cancelar (na fila ou rodando)", { 200: ok("Cancelada"), 409: err("Já terminou"), ...inWs }, { parameters: [wsParam, idParam(), idParam("execId")] }) },

    "/../hooks/{token}": {
      post: op("Webhook", "Dispara o fluxo (URL pública, fora de /api; sem cookie)", {
        202: ok("Na fila", { type: "object", properties: { executionId: { type: "string" }, duplicate: { type: "boolean" } } }),
        200: ok("Reenvio com a mesma Idempotency-Key: devolve a execução existente"),
        404: err("Token errado ou fluxo desligado"), 413: err("Corpo acima de 256 KB"), 429: err("Rate limit ou cota diária (Retry-After)"),
      }, {
        security: [],
        parameters: [
          { name: "token", in: "path", required: true, schema: { type: "string" } },
          { name: "Idempotency-Key", in: "header", schema: { type: "string", maxLength: 200 } },
        ],
        requestBody: { content: json({ type: "object" }) },
      }),
    },
  },
};
