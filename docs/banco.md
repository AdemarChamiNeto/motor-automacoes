# Banco de dados

Schema feito pelo roteiro `_padroes/prompt-banco-de-dados.md`. O SQL completo, comentado, está em
[`backend/migrations/001_inicial.sql`](../backend/migrations/001_inicial.sql).

## Contexto (seções 02 a 09 do roteiro)

| Campo | Resposta |
|---|---|
| O que faz | Fluxos de automação visuais (gatilho → condição → chamada HTTP → notificação) executados de verdade, com fila, agendamento, retries e histórico |
| Modelo | Projeto de portfólio, com demo pública gratuita |
| Multi-tenant | Sim, isolado por **workspace** |
| Banco / back | PostgreSQL 16 (Neon em produção) · Node + Express · SQL puro com `pg` |
| Acesso | O front sempre passa pela API; nunca fala com o banco |
| Volume | Dezenas de usuários. A tabela que mais cresce é `execution_steps` (cota de 500 execuções/dia por workspace × ~5 passos) |
| Consultas frequentes | Próxima execução da fila · histórico de um fluxo · fluxos do workspace · webhook pelo token · agendamentos vencidos |
| Papéis | **owner**: tudo, membros e apagar o workspace · **editor**: cria, edita e roda fluxos e credenciais · **viewer**: só vê fluxos e histórico |
| Auth | Própria: e-mail e senha (bcrypt 12) + 2FA TOTP opcional + códigos de recuperação. Sem recuperação de senha no MVP (não há serviço de e-mail) |
| Convites | Por link (token de uso único, 7 dias) e por e-mail cadastrado (pendente até a pessoa entrar; a resposta não revela se o e-mail tem conta) |
| Integrações | Discord e Slack (URL de webhook), Telegram (token do bot), cabeçalho HTTP. Segredos criptografados |

## 1. Diagrama

```
users ─1:1─ user_passwords      (hash bcrypt)
  │   ─1:1─ user_totp           (segredo AES-GCM, último passo usado)
  │   ─1:N─ recovery_codes      (SHA-256, uso único)
  │
  └─N:N─ workspaces   via workspace_members (owner | editor | viewer; único por par)
            ├─1:N─ workspace_invites   (link: hash do token | e-mail; papel; expira)
            ├─1:N─ credentials         (tipo, nome, segredo AES-GCM que só o worker lê)
            └─1:N─ workflows           (rascunho jsonb, versão publicada, ativo)
                      ├─1:N─ workflow_versions  (definição jsonb imutável, nº por fluxo)
                      ├─1:N─ workflow_triggers  (webhook: hash do token | agendamento: cron, fuso, next_run_at)
                      └─1:N─ executions = A FILA (queued → running → succeeded | failed | canceled)
                                 └─1:N─ execution_steps (nó, tentativa, entrada, saída, erro, duração)
```

## 2. Decisões

- **A fila é a tabela `executions`.** O worker pega com `FOR UPDATE SKIP LOCKED`. Enfileirar é um INSERT na mesma transação que valida o pedido, então não existe "salvou no banco mas o job sumiu no Redis". É um serviço a menos para hospedar no plano grátis.
- **Posse com prazo (lease).** O worker marca `locked_until` e renova a cada passo. Se ele morrer, o lease vence e a execução volta para a fila. Toda gravação confere `locked_by` (*fencing*): um worker atrasado não grava por cima de outro.
- **Retry por passo, não pelo fluxo.** Passos que já deram certo são reaproveitados na tentativa seguinte, para não mandar a mesma notificação duas vezes. As chamadas HTTP levam `Idempotency-Key: <execução>:<nó>`.
- **Versão publicada imutável** (trigger bloqueia UPDATE). A execução aponta para a versão que rodou: editar o fluxo no meio não muda o que já está na fila.
- **Dois papéis do banco para a aplicação.** O dono das tabelas não passa pelo RLS, então a aplicação nunca fica nele. Cada transação faz `SET LOCAL ROLE`:
  - `motor_app`: usuário logado, isolado pelo RLS via `app.user_id`;
  - `motor_system`: login, webhook, worker e agendador.

  Um `DATABASE_URL` só, e funciona no Neon (o dono não é superusuário). O teste local usa um dono sem superusuário, igual ao Neon.
- **Segredo da credencial fora do alcance da API logada:** `motor_app` não tem permissão na coluna `secret_encrypted`. Nem um bug que faça `SELECT *` devolve o segredo. Só o worker decifra.
- **`workspace_id` repetido nas tabelas filhas, com FK composta** (`(workflow_id, workspace_id) → workflows(id, workspace_id)`). Isso deixa as policies simples e indexadas, e o banco garante que filho e pai são do mesmo workspace.
- **Credencial referenciada dentro do JSON do fluxo** (sem FK possível). A conferência acontece ao publicar e de novo na execução: o worker só usa credencial `WHERE id AND workspace_id = da execução AND kind certo AND não apagada`.
- **Sempre um owner por workspace:** trigger `SECURITY DEFINER` que trava a linha do workspace.
  - O teste de concorrência (dois owners rebaixando um ao outro) achou um bug na primeira versão. A função rodava com o RLS de quem chamou: depois de esperar o lock, o Postgres reavaliava a linha, o workspace "sumia" e a checagem era pulada.
- **Cota com advisory lock por workspace**, para que pedidos simultâneos não passem juntos do limite.
- **Agendamento perdido roda uma vez, não N.** Isso acontece com o servidor dormindo no plano grátis. A chave `schedule:<horário>` impede duas instâncias de criarem a mesma execução.
- **Soft delete** em usuários, workspaces, convites, credenciais e fluxos.
  - Execuções e passos são **apagados de verdade** depois de 30 dias: é log, não dado do usuário, e o `input` pode ter dado pessoal vindo do webhook.
  - Participação em workspace também é apagada de verdade (sair não tem valor histórico).
- **UUID gerado pelo banco**, `timestamptz` em UTC, `updated_at` por trigger e enums para status.

## 3 a 6. SQL, triggers, índices e policies

Estão no arquivo da migração, na ordem de dependência. Cada FK tem o `ON DELETE` comentado e cada índice tem o motivo.

Resumo das policies de `motor_app`:

| Tabela | Ver | Criar | Alterar | Apagar |
|---|---|---|---|---|
| users | a si e colegas de workspace | (cadastro: sistema) | o próprio nome | — |
| user_passwords, user_totp, recovery_codes | — | — | — | — (só sistema) |
| workspaces | membros | (sistema, junto com o 1º owner) | owner (nome, soft delete) | — |
| workspace_members | membros | owner | owner | owner, ou a própria linha (sair) |
| workspace_invites | owner; convidado vê os pendentes do seu e-mail | owner | owner (revogar) | — |
| credentials | membros (**sem a coluna do segredo**) | editor+ | editor+ | soft delete |
| workflows, versions, triggers | membros | editor+ | editor+ (versão: nunca) | soft delete / gatilho: editor+ |
| executions | membros | editor+, só `manual` e em nome de si | editor+ (cancelar) | — |
| execution_steps | membros | — (worker) | — | — |

## 7. Seed

Os testes de `src/db/rls.test.ts` montam o cenário mínimo (2 workspaces, owner/editor/viewer, credencial) e provam cada policy.

## 8. Pontos de atenção

- `execution_steps` é a tabela que cresce. Ela já tem a limpeza de 30 dias; se crescer muito, particionar por mês (`created_at`) e apagar partições inteiras.
- Rate limit em memória (uma instância no Render). Com mais de uma, ir para o banco.
- O worker roda no mesmo processo da API (plano grátis). Com carga, separar em outro serviço: a fila no banco já permite vários workers sem mudança.
- O polling de 1 s pode virar `LISTEN/NOTIFY` se a latência importar.
- `SET ROLE` é defesa em profundidade, não fronteira absoluta: quem conseguisse rodar SQL arbitrário poderia fazer `RESET ROLE`. Por isso as consultas continuam todas parametrizadas.
