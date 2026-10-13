/**
 * Fluxos de exemplo criados em todo workspace pessoal novo: a demo abre com algo para rodar.
 * Publicados e DESLIGADOS (ninguém dispara chamadas sozinho); "Executar agora" funciona na hora.
 * As notificações vêm sem credencial: rodam em modo de teste e a mensagem aparece no histórico.
 */
export const SAMPLE_FLOWS = [
  {
    name: "Cotação do dólar",
    description: "Busca a cotação do dólar (Frankfurter, taxas do Banco Central Europeu) e avisa no Telegram quando passa do limite.",
    draft: {
      nodes: [
        { id: "inicio", type: "trigger.manual", position: { x: 0, y: 120 }, data: {} },
        {
          id: "cotacao", type: "http", position: { x: 260, y: 120 },
          data: { method: "GET", url: "https://api.frankfurter.dev/v1/latest?base=USD&symbols=BRL", headers: [], timeoutMs: 8000, attempts: 3 },
        },
        {
          id: "acima", type: "condition", position: { x: 540, y: 120 },
          data: { left: "{{steps.cotacao.body.rates.BRL}}", operator: "gt", right: "4" },
        },
        {
          id: "avisar", type: "notify.telegram", position: { x: 820, y: 40 },
          data: { credentialId: null, chatId: "123456789", message: "Dólar a R$ {{steps.cotacao.body.rates.BRL}} (cotação de {{steps.cotacao.body.date}})", attempts: 3 },
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
    name: "Triagem de chamado com IA",
    description: "Recebe chamados por webhook, a IA (Gemini ou Claude) classifica a urgência e os urgentes vão para o Discord com um resumo.",
    draft: {
      nodes: [
        { id: "chamado", type: "trigger.webhook", position: { x: 0, y: 120 }, data: {} },
        {
          id: "triagem", type: "ai", position: { x: 270, y: 120 },
          data: {
            provider: "gemini", model: "", credentialId: null, mode: "category",
            instructions: "Você faz a triagem de chamados de suporte de TI. Classifique a urgência: \"urgente\" se o sistema parou ou há muita gente afetada, \"normal\" se atrapalha mas tem contorno, \"baixa\" se é dúvida ou pedido.",
            input: "Título: {{trigger.body.titulo}}\nDescrição: {{trigger.body.descricao}}",
            categories: ["urgente", "normal", "baixa"], maxTokens: 100, timeoutMs: 20000, attempts: 2,
          },
        },
        {
          id: "eh_urgente", type: "condition", position: { x: 540, y: 120 },
          data: { left: "{{steps.triagem.category}}", operator: "eq", right: "urgente" },
        },
        {
          id: "resumo", type: "ai", position: { x: 810, y: 40 },
          data: {
            provider: "gemini", model: "", credentialId: null, mode: "text",
            instructions: "Resuma o chamado em uma frase curta, dizendo o que parou e quem está afetado.",
            input: "{{trigger.body.descricao}}", categories: [], maxTokens: 150, timeoutMs: 20000, attempts: 2,
          },
        },
        {
          id: "discord", type: "notify.discord", position: { x: 1080, y: 40 },
          data: { credentialId: null, message: "🚨 Chamado urgente: {{trigger.body.titulo}}\n{{steps.resumo.text}}", attempts: 3 },
        },
      ],
      edges: [
        { id: "e1", source: "chamado", target: "triagem" },
        { id: "e2", source: "triagem", target: "eh_urgente" },
        { id: "e3", source: "eh_urgente", target: "resumo", sourceHandle: "true" },
        { id: "e4", source: "resumo", target: "discord" },
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
