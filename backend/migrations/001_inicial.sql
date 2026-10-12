-- =====================================================================================
-- Motor de automações: schema inicial
-- Roteiro: _padroes/prompt-banco-de-dados.md · decisões e diagrama em docs/banco.md
--
-- Quem roda esta migração é o dono das tabelas (o usuário do DATABASE_URL). A aplicação NÃO
-- consulta como dono: cada transação troca para um destes papéis (SET LOCAL ROLE):
--   motor_app     pedidos de um usuário logado; o RLS isola por workspace (app.user_id)
--   motor_system  login, cadastro, webhooks, worker, agendador e limpeza; código explícito e curto
-- Dono de tabela não passa pelo RLS, por isso a aplicação nunca fica nele.
-- =====================================================================================

-- ---------- papéis da aplicação (sem login: só se entra neles com SET ROLE) ----------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'motor_app') THEN
    CREATE ROLE motor_app NOLOGIN NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'motor_system') THEN
    CREATE ROLE motor_system NOLOGIN NOBYPASSRLS;
  END IF;
END $$;
-- o usuário da conexão precisa ser membro para poder fazer SET ROLE (no Postgres 16+, quem cria
-- o papel ganha só ADMIN; a participação é concedida aqui)
GRANT motor_app TO CURRENT_USER;
GRANT motor_system TO CURRENT_USER;
GRANT USAGE ON SCHEMA public TO motor_app, motor_system;

-- ---------- tipos ----------
-- A ordem importa: viewer < editor < owner, então "papel >= 'editor'" funciona direto.
CREATE TYPE workspace_role AS ENUM ('viewer', 'editor', 'owner');
CREATE TYPE credential_kind AS ENUM ('discord_webhook', 'slack_webhook', 'telegram_bot', 'http_header');
CREATE TYPE trigger_kind AS ENUM ('webhook', 'schedule', 'manual');
-- queued → running → succeeded | failed | canceled  (running volta a queued no retry ou se o worker morrer)
CREATE TYPE execution_status AS ENUM ('queued', 'running', 'succeeded', 'failed', 'canceled');
CREATE TYPE step_status AS ENUM ('succeeded', 'failed', 'skipped');

-- ---------- updated_at pelo banco ----------
CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- =====================================================================================
-- Usuários e autenticação própria
-- =====================================================================================

-- Perfil. A credencial fica em tabelas separadas (regra fixa do roteiro).
CREATE TABLE users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  email       text NOT NULL CHECK (email = lower(btrim(email)) AND email LIKE '%_@_%' AND length(email) <= 254),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);
-- e-mail único entre as contas ativas (normalizado em minúsculas pelo CHECK); serve também à busca no login
CREATE UNIQUE INDEX users_email_key ON users (email) WHERE deleted_at IS NULL;

CREATE TABLE user_passwords (
  -- CASCADE: a senha não existe sem o usuário. user_id é a própria chave (1:1).
  user_id        uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  password_hash  text NOT NULL CHECK (password_hash LIKE '$2_$%'), -- SENSÍVEL: bcrypt custo 12
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Segundo fator. enabled_at NULL = QR gerado, ainda não confirmado com um código.
CREATE TABLE user_totp (
  user_id           uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE, -- CASCADE: 1:1 com o usuário
  secret_encrypted  text NOT NULL,   -- SENSÍVEL: AES-256-GCM com ENCRYPTION_KEY
  enabled_at        timestamptz,
  last_used_step    bigint,          -- impede reusar o mesmo código dentro da janela de 30 s
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE recovery_codes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE, -- CASCADE: só valem para a conta dona
  code_hash   text NOT NULL CHECK (length(code_hash) = 64),          -- SENSÍVEL: SHA-256, nunca o código
  used_at     timestamptz,                                           -- uso único
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, code_hash) -- user_id na frente: também serve de índice da chave estrangeira
);

-- =====================================================================================
-- Workspaces (o tenant)
-- =====================================================================================

CREATE TABLE workspaces (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);

CREATE TABLE workspace_members (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- CASCADE nas duas: a participação não tem sentido sem o workspace ou sem o usuário.
  -- Sair do workspace apaga a linha de verdade (não há valor histórico; quem fez o quê fica nas execuções).
  workspace_id  uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role          workspace_role NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, user_id) -- uma participação por pessoa; também é o índice de workspace_id
);
-- "meus workspaces" e a checagem de papel do RLS partem do usuário
CREATE INDEX workspace_members_user_idx ON workspace_members (user_id);

-- Convite por link (token_hash) OU por e-mail (email): exatamente um dos dois.
CREATE TABLE workspace_invites (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE, -- CASCADE: convite morre com o workspace
  role          workspace_role NOT NULL CHECK (role <> 'owner'),           -- ninguém entra já como dono
  email         text CHECK (email = lower(btrim(email))),
  token_hash    text CHECK (length(token_hash) = 64),                      -- SENSÍVEL: SHA-256 do token do link
  -- SET NULL: o convite continua no histórico mesmo se a conta de quem convidou sumir
  invited_by    uuid REFERENCES users (id) ON DELETE SET NULL,
  expires_at    timestamptz NOT NULL,
  accepted_at   timestamptz,
  accepted_by   uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz, -- convite revogado
  CHECK (num_nonnulls(email, token_hash) = 1),
  CHECK ((accepted_at IS NULL) = (accepted_by IS NULL))
);
-- lista de convites do workspace (tela do owner) e índice da FK
CREATE INDEX workspace_invites_workspace_idx ON workspace_invites (workspace_id);
-- abrir o link: busca pelo hash do token
CREATE UNIQUE INDEX workspace_invites_token_key ON workspace_invites (token_hash) WHERE token_hash IS NOT NULL;
-- um convite pendente por e-mail em cada workspace; também serve para "convites para o meu e-mail"
CREATE UNIQUE INDEX workspace_invites_email_pending_key ON workspace_invites (email, workspace_id)
  WHERE email IS NOT NULL AND accepted_at IS NULL AND deleted_at IS NULL;
-- índices das FKs para users (SET NULL precisa achar as linhas quando a conta é apagada)
CREATE INDEX workspace_invites_invited_by_idx ON workspace_invites (invited_by) WHERE invited_by IS NOT NULL;
CREATE INDEX workspace_invites_accepted_by_idx ON workspace_invites (accepted_by) WHERE accepted_by IS NOT NULL;

-- =====================================================================================
-- Credenciais das integrações (Discord, Slack, Telegram, cabeçalho HTTP)
-- =====================================================================================

CREATE TABLE credentials (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE, -- CASCADE: pertence ao workspace
  kind              credential_kind NOT NULL,
  name              text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  -- SENSÍVEL: AES-256-GCM. Ninguém lê depois de salvo: motor_app nem tem permissão nesta coluna
  -- (ver os GRANTs por coluna no fim); só o worker (motor_system) decifra na hora de usar.
  secret_encrypted  text NOT NULL,
  created_by        uuid REFERENCES users (id) ON DELETE SET NULL, -- SET NULL: a credencial é do workspace, não da pessoa
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz,
  UNIQUE (id, workspace_id) -- alvo de FK composta (garante que a referência é do mesmo workspace)
);
-- nome único entre as ativas do workspace; também é o índice da FK e da listagem
CREATE UNIQUE INDEX credentials_name_key ON credentials (workspace_id, name) WHERE deleted_at IS NULL;
CREATE INDEX credentials_created_by_idx ON credentials (created_by) WHERE created_by IS NOT NULL;

-- =====================================================================================
-- Fluxos, versões publicadas e gatilhos
-- =====================================================================================

CREATE TABLE workflows (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE, -- CASCADE: pertence ao workspace
  name                  text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  description           text NOT NULL DEFAULT '' CHECK (length(description) <= 500),
  -- rascunho editável no editor; o que roda é sempre uma versão publicada (imutável)
  draft                 jsonb NOT NULL CHECK (jsonb_typeof(draft) = 'object'),
  published_version_id  uuid, -- FK adicionada depois de criar workflow_versions (referência circular)
  is_active             boolean NOT NULL DEFAULT false,
  created_by            uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  deleted_at            timestamptz,
  UNIQUE (id, workspace_id),
  CHECK (NOT is_active OR published_version_id IS NOT NULL) -- só fica ativo o que já foi publicado
);
-- nome único entre os fluxos ativos do workspace; também é o índice da FK e da listagem
CREATE UNIQUE INDEX workflows_name_key ON workflows (workspace_id, name) WHERE deleted_at IS NULL;
CREATE INDEX workflows_created_by_idx ON workflows (created_by) WHERE created_by IS NOT NULL;

CREATE TABLE workflow_versions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL,
  workflow_id   uuid NOT NULL,
  version       integer NOT NULL CHECK (version > 0),
  definition    jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
  created_by    uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  -- CASCADE: a versão não existe sem o fluxo. Composta: a versão é obrigatoriamente do mesmo workspace.
  FOREIGN KEY (workflow_id, workspace_id) REFERENCES workflows (id, workspace_id) ON DELETE CASCADE,
  UNIQUE (workflow_id, version), -- numeração por fluxo; também é o índice da FK
  UNIQUE (id, workflow_id)
);
CREATE INDEX workflow_versions_created_by_idx ON workflow_versions (created_by) WHERE created_by IS NOT NULL;

-- A versão publicada tem que ser deste mesmo fluxo (FK composta).
-- RESTRICT: não dá para apagar a versão que está publicada.
ALTER TABLE workflows
  ADD CONSTRAINT workflows_published_version_fk FOREIGN KEY (published_version_id, id)
  REFERENCES workflow_versions (id, workflow_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
-- (deferrable: ao apagar um fluxo de verdade, o CASCADE remove as versões no mesmo comando)

-- Versão publicada é imutável: o histórico de execuções aponta para ela.
CREATE FUNCTION forbid_version_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.definition IS DISTINCT FROM OLD.definition OR NEW.version <> OLD.version
     OR NEW.workflow_id <> OLD.workflow_id OR NEW.workspace_id <> OLD.workspace_id THEN
    RAISE EXCEPTION 'versão publicada não pode ser alterada' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER workflow_versions_immutable BEFORE UPDATE ON workflow_versions
  FOR EACH ROW EXECUTE FUNCTION forbid_version_change();

-- Gatilhos ativos, derivados da versão publicada. Tabela própria para o agendador e o webhook
-- acharem o fluxo por índice, sem abrir o JSON de todas as versões.
CREATE TABLE workflow_triggers (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL,
  workflow_id         uuid NOT NULL,
  kind                trigger_kind NOT NULL CHECK (kind <> 'manual'), -- manual não precisa de linha aqui
  webhook_token_hash  text CHECK (length(webhook_token_hash) = 64),  -- SENSÍVEL: SHA-256 do token da URL
  cron                text CHECK (length(cron) <= 100),
  timezone            text CHECK (length(timezone) <= 64),
  next_run_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  -- CASCADE: o gatilho não existe sem o fluxo
  FOREIGN KEY (workflow_id, workspace_id) REFERENCES workflows (id, workspace_id) ON DELETE CASCADE,
  UNIQUE (workflow_id, kind), -- um webhook e um agendamento por fluxo; também é o índice da FK
  CHECK (kind <> 'webhook' OR (webhook_token_hash IS NOT NULL AND cron IS NULL)),
  CHECK (kind <> 'schedule' OR (cron IS NOT NULL AND timezone IS NOT NULL AND webhook_token_hash IS NULL))
);
-- chegada de webhook: busca pelo hash do token
CREATE UNIQUE INDEX workflow_triggers_webhook_key ON workflow_triggers (webhook_token_hash) WHERE webhook_token_hash IS NOT NULL;
-- agendador: "o que vence agora", só entre os agendamentos com próxima execução marcada
CREATE INDEX workflow_triggers_due_idx ON workflow_triggers (next_run_at) WHERE kind = 'schedule' AND next_run_at IS NOT NULL;

-- =====================================================================================
-- Execuções (a própria fila) e passos
-- =====================================================================================

CREATE TABLE executions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid NOT NULL,
  workflow_id      uuid NOT NULL,
  version_id       uuid NOT NULL,
  trigger          trigger_kind NOT NULL,
  status           execution_status NOT NULL DEFAULT 'queued',
  input            jsonb NOT NULL DEFAULT '{}'::jsonb,  -- pode ter dado pessoal vindo do webhook: some na limpeza de 30 dias
  idempotency_key  text CHECK (length(idempotency_key) <= 200),
  attempt          integer NOT NULL DEFAULT 0 CHECK (attempt >= 0), -- quantas vezes um worker pegou esta execução
  run_at           timestamptz NOT NULL DEFAULT now(),              -- quando pode ser pega (backoff do retry)
  locked_until     timestamptz,                                     -- prazo da posse do worker (lease)
  locked_by        text,
  started_at       timestamptz,
  finished_at      timestamptz,
  error            text CHECK (length(error) <= 2000),
  created_by       uuid REFERENCES users (id) ON DELETE SET NULL,   -- quem rodou manualmente
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  -- CASCADE: o histórico vai junto quando o fluxo é apagado de verdade
  FOREIGN KEY (workflow_id, workspace_id) REFERENCES workflows (id, workspace_id) ON DELETE CASCADE,
  -- a versão tem que ser deste fluxo; CASCADE pelo mesmo motivo
  FOREIGN KEY (version_id, workflow_id) REFERENCES workflow_versions (id, workflow_id) ON DELETE CASCADE,
  UNIQUE (id, workspace_id),
  CHECK (status <> 'running' OR (locked_until IS NOT NULL AND locked_by IS NOT NULL)),
  CHECK ((status IN ('succeeded', 'failed', 'canceled')) = (finished_at IS NOT NULL))
);
-- O CORAÇÃO DA FILA: o worker busca "queued com run_at vencido" em ordem; índice parcial só com a fila
CREATE INDEX executions_queue_idx ON executions (run_at) WHERE status = 'queued';
-- recuperação: execuções "running" cujo worker sumiu (lease vencido)
CREATE INDEX executions_lease_idx ON executions (locked_until) WHERE status = 'running';
-- histórico de um fluxo, mais recentes primeiro; também é o índice da FK (workflow_id na frente)
CREATE INDEX executions_workflow_idx ON executions (workflow_id, created_at DESC);
-- histórico do workspace e cota diária ("quantas execuções hoje")
CREATE INDEX executions_workspace_idx ON executions (workspace_id, created_at DESC);
-- reenvio do mesmo webhook (Idempotency-Key) não cria outra execução
CREATE UNIQUE INDEX executions_idempotency_key ON executions (workflow_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
-- FK da versão
CREATE INDEX executions_version_idx ON executions (version_id);
CREATE INDEX executions_created_by_idx ON executions (created_by) WHERE created_by IS NOT NULL;
-- limpeza dos 30 dias: tabela quase só de inserção em ordem de tempo, então BRIN é minúsculo e basta
CREATE INDEX executions_created_brin ON executions USING brin (created_at);

CREATE TABLE execution_steps (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL,
  execution_id  uuid NOT NULL,
  node_id       text NOT NULL CHECK (length(node_id) BETWEEN 1 AND 64),
  node_type     text NOT NULL CHECK (length(node_type) <= 40),
  attempt       integer NOT NULL CHECK (attempt > 0),
  status        step_status NOT NULL,
  input         jsonb,  -- config já resolvida, com segredos e cabeçalhos de autenticação mascarados
  output        jsonb,
  error         text CHECK (length(error) <= 2000),
  started_at    timestamptz NOT NULL,
  finished_at   timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  -- CASCADE: o passo não existe sem a execução (e vai embora com ela na limpeza)
  FOREIGN KEY (execution_id, workspace_id) REFERENCES executions (id, workspace_id) ON DELETE CASCADE,
  UNIQUE (execution_id, node_id, attempt), -- uma linha por tentativa de cada nó; também é o índice da FK
  CHECK (finished_at >= started_at)
);

-- =====================================================================================
-- Regra: todo workspace ativo tem pelo menos um owner
-- =====================================================================================
-- SECURITY DEFINER: a regra olha os dados de verdade, não o que o RLS deixa quem chamou ver.
-- (Sem isso, achado pelo teste de concorrência: o segundo owner espera o lock, o Postgres reavalia
-- a linha com o RLS dele, ele já não é owner, o workspace "some" e a checagem era pulada.)
CREATE FUNCTION keep_one_owner() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ws_active boolean;
BEGIN
  IF OLD.role <> 'owner' OR (TG_OP = 'UPDATE' AND NEW.role = 'owner') THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  -- trava o workspace: dois owners rebaixando um ao outro ao mesmo tempo não deixam o workspace sem dono
  SELECT deleted_at IS NULL INTO ws_active FROM workspaces WHERE id = OLD.workspace_id FOR UPDATE;
  IF ws_active AND NOT EXISTS (
    SELECT 1 FROM workspace_members
    WHERE workspace_id = OLD.workspace_id AND role = 'owner' AND id <> OLD.id
  ) THEN
    RAISE EXCEPTION 'o workspace precisa de pelo menos um owner' USING ERRCODE = 'check_violation', HINT = 'last_owner';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER workspace_members_keep_owner BEFORE UPDATE OF role OR DELETE ON workspace_members
  FOR EACH ROW EXECUTE FUNCTION keep_one_owner();

-- ---------- updated_at em todas as tabelas ----------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['users', 'user_passwords', 'user_totp', 'recovery_codes', 'workspaces',
    'workspace_members', 'workspace_invites', 'credentials', 'workflows', 'workflow_versions',
    'workflow_triggers', 'executions', 'execution_steps']
  LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
                   t || '_updated_at', t);
  END LOOP;
END $$;

-- =====================================================================================
-- Row Level Security
-- =====================================================================================

-- Usuário da transação (SET LOCAL app.user_id). Sem valor → NULL → nenhuma policy de motor_app passa.
CREATE FUNCTION app_user_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::uuid
$$;

-- Papel do usuário atual no workspace (NULL se não for membro ou se o workspace foi apagado).
-- SECURITY DEFINER: lê workspace_members sem passar pelo RLS dela mesma (evita recursão infinita).
CREATE FUNCTION my_role(ws uuid) RETURNS workspace_role
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT m.role FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
  WHERE m.workspace_id = ws AND m.user_id = app_user_id() AND w.deleted_at IS NULL
$$;

-- O usuário atual divide algum workspace com "other"? (para mostrar nome e e-mail dos colegas)
CREATE FUNCTION shares_workspace(other uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM workspace_members a JOIN workspace_members b ON b.workspace_id = a.workspace_id
    WHERE a.user_id = app_user_id() AND b.user_id = other
  )
$$;

CREATE FUNCTION my_email() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT email FROM users WHERE id = app_user_id() AND deleted_at IS NULL
$$;

REVOKE ALL ON FUNCTION my_role(uuid), shares_workspace(uuid), my_email() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_user_id(), my_role(uuid), shares_workspace(uuid), my_email() TO motor_app, motor_system;

-- Liga o RLS em tudo. Sem policy, o padrão é negar.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['users', 'user_passwords', 'user_totp', 'recovery_codes', 'workspaces',
    'workspace_members', 'workspace_invites', 'credentials', 'workflows', 'workflow_versions',
    'workflow_triggers', 'executions', 'execution_steps']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    -- motor_system: código de sistema (login, webhook, worker), sem usuário logado; acesso total e explícito
    EXECUTE format('CREATE POLICY system_all ON %I TO motor_system USING (true) WITH CHECK (true)', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO motor_system', t);
  END LOOP;
END $$;

-- ---------- motor_app (usuário logado) ----------
-- Senha, 2FA e códigos de recuperação: nenhum acesso. O fluxo de login e de 2FA roda como motor_system.

-- users: vê a si mesmo e os colegas de workspace; edita só o próprio perfil
GRANT SELECT (id, name, email, created_at, updated_at, deleted_at), UPDATE (name) ON users TO motor_app;
CREATE POLICY users_select ON users FOR SELECT TO motor_app
  USING (id = app_user_id() OR shares_workspace(id));
CREATE POLICY users_update ON users FOR UPDATE TO motor_app
  USING (id = app_user_id()) WITH CHECK (id = app_user_id());

-- workspaces: qualquer membro vê; owner renomeia e apaga (soft delete). Criar roda como motor_system
-- (cria o workspace e o primeiro owner na mesma transação).
GRANT SELECT, UPDATE (name, deleted_at) ON workspaces TO motor_app;
CREATE POLICY workspaces_select ON workspaces FOR SELECT TO motor_app
  USING (my_role(id) IS NOT NULL);
CREATE POLICY workspaces_update ON workspaces FOR UPDATE TO motor_app
  USING (my_role(id) = 'owner') WITH CHECK (true);
  -- WITH CHECK (true): depois do soft delete o owner deixa de "ver" o workspace; o USING já garantiu que era owner

-- membros: todos veem; owner adiciona, muda papel e remove; qualquer um pode sair (apagar a própria linha)
GRANT SELECT, INSERT, UPDATE (role), DELETE ON workspace_members TO motor_app;
CREATE POLICY members_select ON workspace_members FOR SELECT TO motor_app
  USING (my_role(workspace_id) IS NOT NULL);
CREATE POLICY members_insert ON workspace_members FOR INSERT TO motor_app
  WITH CHECK (my_role(workspace_id) = 'owner');
CREATE POLICY members_update ON workspace_members FOR UPDATE TO motor_app
  USING (my_role(workspace_id) = 'owner') WITH CHECK (my_role(workspace_id) = 'owner');
CREATE POLICY members_delete ON workspace_members FOR DELETE TO motor_app
  USING (my_role(workspace_id) = 'owner' OR user_id = app_user_id());

-- convites: owner gerencia; a pessoa convidada por e-mail vê os pendentes para o e-mail dela.
-- Aceitar roda como motor_system (quem aceita ainda não é membro).
GRANT SELECT (id, workspace_id, role, email, invited_by, expires_at, accepted_at, accepted_by, created_at, updated_at, deleted_at),
      INSERT (workspace_id, role, email, token_hash, invited_by, expires_at),
      UPDATE (deleted_at)
  ON workspace_invites TO motor_app;
CREATE POLICY invites_select ON workspace_invites FOR SELECT TO motor_app
  USING (my_role(workspace_id) = 'owner'
         OR (email = my_email() AND accepted_at IS NULL AND deleted_at IS NULL AND expires_at > now()));
CREATE POLICY invites_insert ON workspace_invites FOR INSERT TO motor_app
  WITH CHECK (my_role(workspace_id) = 'owner' AND invited_by = app_user_id());
CREATE POLICY invites_update ON workspace_invites FOR UPDATE TO motor_app
  USING (my_role(workspace_id) = 'owner') WITH CHECK (my_role(workspace_id) = 'owner');

-- credenciais: todos veem nome e tipo; editor cria, renomeia, troca o segredo e apaga (soft delete).
-- secret_encrypted fica FORA do SELECT: nem um bug na API consegue devolver o segredo.
GRANT SELECT (id, workspace_id, kind, name, created_by, created_at, updated_at, deleted_at),
      INSERT (workspace_id, kind, name, secret_encrypted, created_by),
      UPDATE (name, secret_encrypted, deleted_at)
  ON credentials TO motor_app;
CREATE POLICY credentials_select ON credentials FOR SELECT TO motor_app
  USING (my_role(workspace_id) IS NOT NULL);
CREATE POLICY credentials_insert ON credentials FOR INSERT TO motor_app
  WITH CHECK (my_role(workspace_id) >= 'editor');
CREATE POLICY credentials_update ON credentials FOR UPDATE TO motor_app
  USING (my_role(workspace_id) >= 'editor') WITH CHECK (my_role(workspace_id) >= 'editor');

-- fluxos, versões e gatilhos: todos veem; editor escreve
GRANT SELECT, INSERT (workspace_id, name, description, draft, created_by),
      UPDATE (name, description, draft, published_version_id, is_active, deleted_at)
  ON workflows TO motor_app;
CREATE POLICY workflows_select ON workflows FOR SELECT TO motor_app
  USING (my_role(workspace_id) IS NOT NULL);
CREATE POLICY workflows_insert ON workflows FOR INSERT TO motor_app
  WITH CHECK (my_role(workspace_id) >= 'editor');
CREATE POLICY workflows_update ON workflows FOR UPDATE TO motor_app
  USING (my_role(workspace_id) >= 'editor') WITH CHECK (my_role(workspace_id) >= 'editor');

GRANT SELECT, INSERT (workspace_id, workflow_id, version, definition, created_by) ON workflow_versions TO motor_app;
CREATE POLICY versions_select ON workflow_versions FOR SELECT TO motor_app
  USING (my_role(workspace_id) IS NOT NULL);
CREATE POLICY versions_insert ON workflow_versions FOR INSERT TO motor_app
  WITH CHECK (my_role(workspace_id) >= 'editor');

GRANT SELECT (id, workspace_id, workflow_id, kind, cron, timezone, next_run_at, created_at, updated_at),
      INSERT (workspace_id, workflow_id, kind, webhook_token_hash, cron, timezone, next_run_at),
      UPDATE (webhook_token_hash, cron, timezone, next_run_at),
      DELETE
  ON workflow_triggers TO motor_app;
CREATE POLICY triggers_select ON workflow_triggers FOR SELECT TO motor_app
  USING (my_role(workspace_id) IS NOT NULL);
CREATE POLICY triggers_insert ON workflow_triggers FOR INSERT TO motor_app
  WITH CHECK (my_role(workspace_id) >= 'editor');
CREATE POLICY triggers_update ON workflow_triggers FOR UPDATE TO motor_app
  USING (my_role(workspace_id) >= 'editor') WITH CHECK (my_role(workspace_id) >= 'editor');
CREATE POLICY triggers_delete ON workflow_triggers FOR DELETE TO motor_app
  USING (my_role(workspace_id) >= 'editor');

-- execuções: todos veem; editor roda manualmente e cancela. Quem processa a fila é o worker (motor_system).
GRANT SELECT, INSERT (workspace_id, workflow_id, version_id, trigger, input, created_by),
      UPDATE (status, finished_at, error, locked_until, locked_by)
  ON executions TO motor_app;
CREATE POLICY executions_select ON executions FOR SELECT TO motor_app
  USING (my_role(workspace_id) IS NOT NULL);
CREATE POLICY executions_insert ON executions FOR INSERT TO motor_app
  WITH CHECK (my_role(workspace_id) >= 'editor' AND trigger = 'manual' AND created_by = app_user_id());
CREATE POLICY executions_update ON executions FOR UPDATE TO motor_app
  USING (my_role(workspace_id) >= 'editor') WITH CHECK (my_role(workspace_id) >= 'editor');

GRANT SELECT ON execution_steps TO motor_app;
CREATE POLICY steps_select ON execution_steps FOR SELECT TO motor_app
  USING (my_role(workspace_id) IS NOT NULL);
