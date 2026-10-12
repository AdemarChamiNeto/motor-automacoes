/**
 * Fluxos de exemplo criados em todo workspace pessoal novo: a demo abre com algo para rodar.
 * Publicados e DESLIGADOS (ninguém dispara chamadas sozinho); "Executar agora" funciona na hora.
 * As notificações vêm sem credencial: rodam em modo de teste e a mensagem aparece no histórico.
 */
export const SAMPLE_FLOWS = [
  {
    name: "Cotação do dólar",
    description: "Busca a cotação na AwesomeAPI e avisa no Telegram quando passa do limite.",
    draft: {
      nodes: [
        { id: "inicio", type: "trigger.manual", position: { x: 0, y: 120 }, data: {} },
        {
          id: "cotacao", type: "http", position: { x: 260, y: 120 },
          data: { method: "GET", url: "https://economia.awesomeapi.com.br/json/last/USD-BRL", headers: [], timeoutMs: 8000, attempts: 3 },
        },
        {
          id: "acima", type: "condition", position: { x: 540, y: 120 },
          data: { left: "{{steps.cotacao.body.USDBRL.bid}}", operator: "gt", right: "4" },
        },
        {
          id: "avisar", type: "notify.telegram", position: { x: 820, y: 40 },
          data: { credentialId: null, chatId: "123456789", message: "Dólar a R$ {{steps.cotacao.body.USDBRL.bid}} ({{steps.cotacao.body.USDBRL.create_date}})", attempts: 3 },
        },
      ],
      edges: [
        { id: "e1", source: "inicio", target: "cotacao" },
        { id: "e2", source: "cotacao", target: "acima" },
        { id: "e3", source: "acima", target: "avisar", sourceHandle: "true" },
      ],
    },
  },
  {
    name: "Pedido grande",
    description: "Recebe pedidos por webhook; acima de R$ 500 avisa a equipe no Discord.",
    draft: {
      nodes: [
        { id: "pedido", type: "trigger.webhook", position: { x: 0, y: 120 }, data: {} },
        {
          id: "grande", type: "condition", position: { x: 260, y: 120 },
          data: { left: "{{trigger.body.valor}}", operator: "gt", right: "500" },
        },
        {
          id: "discord", type: "notify.discord", position: { x: 540, y: 40 },
          data: { credentialId: null, message: "Pedido {{trigger.body.id}} de {{trigger.body.cliente}}: R$ {{trigger.body.valor}}", attempts: 3 },
        },
        {
          id: "slack", type: "notify.slack", position: { x: 540, y: 220 },
          data: { credentialId: null, message: "Pedido comum {{trigger.body.id}} registrado", attempts: 3 },
        },
      ],
      edges: [
        { id: "e1", source: "pedido", target: "grande" },
        { id: "e2", source: "grande", target: "discord", sourceHandle: "true" },
        { id: "e3", source: "grande", target: "slack", sourceHandle: "false" },
      ],
    },
  },
  {
    name: "Monitor do GitHub",
    description: "De hora em hora consulta o status do GitHub e avisa no Slack se houver instabilidade.",
    draft: {
      nodes: [
        { id: "relogio", type: "trigger.schedule", position: { x: 0, y: 120 }, data: { cron: "0 * * * *", timezone: "America/Sao_Paulo" } },
        {
          id: "status", type: "http", position: { x: 260, y: 120 },
          data: { method: "GET", url: "https://www.githubstatus.com/api/v2/status.json", headers: [], timeoutMs: 8000, attempts: 3 },
        },
        {
          id: "instavel", type: "condition", position: { x: 540, y: 120 },
          data: { left: "{{steps.status.body.status.indicator}}", operator: "neq", right: "none" },
        },
        {
          id: "slack", type: "notify.slack", position: { x: 820, y: 40 },
          data: { credentialId: null, message: "GitHub: {{steps.status.body.status.description}}", attempts: 3 },
        },
      ],
      edges: [
        { id: "e1", source: "relogio", target: "status" },
        { id: "e2", source: "status", target: "instavel" },
        { id: "e3", source: "instavel", target: "slack", sourceHandle: "true" },
      ],
    },
  },
];
