-- Chaves de API dos provedores de IA (nó "ia"). O valor novo do enum só pode ser usado depois
-- do COMMIT desta migração, e nada aqui usa: por isso roda dentro da transação do migrate.
ALTER TYPE credential_kind ADD VALUE IF NOT EXISTS 'anthropic_key';
ALTER TYPE credential_kind ADD VALUE IF NOT EXISTS 'gemini_key';
