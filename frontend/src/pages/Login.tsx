import { useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { api, ApiError, type User } from "../api";
import { Icon } from "../ui/icons";

/**
 * Para onde voltar depois do login: só caminho deste site. Passa pelo mesmo parser de URL do
 * navegador, porque "/\site.com" e "//site.com" parecem internos mas levam para fora.
 */
export function safeReturn(raw: string | null): string {
  if (!raw || !raw.startsWith("/")) return "/";
  try {
    const base = "https://motor.invalid";
    const url = new URL(raw, base);
    return url.origin === base ? url.pathname + url.search + url.hash : "/";
  } catch {
    return "/";
  }
}

type Mode = "login" | "register" | "code";

export function Login() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [mode, setMode] = useState<Mode>("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  /** Grava o usuário que a API devolveu (o cache ainda tem o null do 401) e volta para onde estava. */
  const done = (user: User) => {
    qc.clear();
    qc.setQueryData(["me"], user);
    navigate(safeReturn(params.get("voltar")), { replace: true });
  };

  async function attempt(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof ApiError && e.problems.length ? e.problems.map((p) => p.message).join("; ") : (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void attempt(async () => {
      if (mode === "register") {
        return done((await api.register(name, email, password)).user);
      }
      if (mode === "code") {
        return done((await api.login2fa(code.trim())).user);
      }
      const r = await api.login(email, password);
      if (r.twoFactorRequired) {
        setMode("code");
        return;
      }
      done(r.user!);
    });
  };

  return (
    <div className="auth-page">
      <section className="auth-pitch">
        <div className="brand big"><Icon name="flow" size={28} /> Motor de Automações</div>
        <h1>Monte fluxos que rodam de verdade.</h1>
        <p>Webhook ou agendamento → condição → chamada de API → aviso no Discord, Slack ou Telegram. Com fila no PostgreSQL, novas tentativas automáticas e histórico de cada passo.</p>
        <button type="button" className="primary big" disabled={busy} onClick={() => void attempt(async () => done((await api.demo()).user))}>
          <Icon name="rocket" /> Experimentar sem cadastro
        </button>
        <p className="small muted">Cria uma conta temporária (24 h) com fluxos de exemplo. Nenhum dado pessoal é pedido.</p>
      </section>

      <form className="auth card" onSubmit={submit} aria-labelledby="auth-title">
        {mode === "code" ? (
          <>
            <h2 id="auth-title">Verificação em duas etapas</h2>
            <p className="small muted">Digite o código de 6 dígitos do app autenticador ou um código de recuperação.</p>
            <label htmlFor="code">Código</label>
            <input id="code" autoComplete="one-time-code" inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} required autoFocus />
          </>
        ) : (
          <>
            <div className="tabs" role="tablist" aria-label="Entrar ou criar conta">
              <button type="button" role="tab" aria-selected={mode === "login"} onClick={() => setMode("login")}>Entrar</button>
              <button type="button" role="tab" aria-selected={mode === "register"} onClick={() => setMode("register")}>Criar conta</button>
            </div>
            <h2 id="auth-title" className="sr-only">{mode === "login" ? "Entrar" : "Criar conta"}</h2>
            {mode === "register" && (
              <>
                <label htmlFor="name">Nome</label>
                <input id="name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} required minLength={2} />
              </>
            )}
            <label htmlFor="email">E-mail</label>
            <input id="email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            <label htmlFor="password">Senha</label>
            <input id="password" type="password" autoComplete={mode === "login" ? "current-password" : "new-password"}
              minLength={mode === "register" ? 8 : undefined} value={password} onChange={(e) => setPassword(e.target.value)} required />
            {mode === "register" && <small className="muted">Pelo menos 8 caracteres.</small>}
          </>
        )}
        {error && <p className="error" role="alert">{error}</p>}
        {params.get("voltar") && !error && mode === "login" && <p className="small muted" role="status">Entre para continuar.</p>}
        <button type="submit" className="primary" disabled={busy}>
          {busy ? "Aguarde…" : mode === "register" ? "Criar conta" : mode === "code" ? "Confirmar" : "Entrar"}
        </button>
        {mode === "code" && <button type="button" className="ghost" onClick={() => setMode("login")}>Voltar</button>}
        <p className="small muted center-text"><a href="/privacidade.html">Privacidade</a> · <a href="/api/docs">API</a></p>
      </form>
    </div>
  );
}
