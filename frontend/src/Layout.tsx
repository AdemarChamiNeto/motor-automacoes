import { NavLink, Outlet, useNavigate, useParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { useMe, useWorkspaces } from "./App";
import { Icon } from "./ui/icons";

export function Layout() {
  const { ws } = useParams();
  const me = useMe();
  const workspaces = useWorkspaces();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const current = workspaces.data?.find((w) => w.id === ws) ?? null;

  async function logout() {
    await api.logout();
    qc.clear();
    navigate("/entrar");
  }

  return (
    <div className="shell">
      <a className="skip" href="#conteudo">Pular para o conteúdo</a>
      <aside className="sidebar">
        <div className="brand"><Icon name="flow" size={22} /> Motor de Automações</div>
        <label className="ws-switch">
          <span className="label">Workspace</span>
          <select value={ws ?? ""} onChange={(e) => navigate(`/w/${e.target.value}`)} aria-label="Trocar de workspace">
            {!ws && <option value="">Escolha…</option>}
            {workspaces.data?.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        </label>
        {current && (
          <nav aria-label="Workspace">
            <NavLink to={`/w/${current.id}`} end><Icon name="flow" /> Fluxos</NavLink>
            <NavLink to={`/w/${current.id}/credenciais`}><Icon name="key" /> Credenciais</NavLink>
            <NavLink to={`/w/${current.id}/membros`}><Icon name="users" /> Membros</NavLink>
          </nav>
        )}
        <nav aria-label="Conta" className="bottom">
          <NavLink to="/conta"><Icon name="user" /> {me.data?.name ?? "Conta"}</NavLink>
          <button type="button" className="navbtn" onClick={logout}><Icon name="logout" /> Sair</button>
          <a href="/api/docs" className="small muted">Documentação da API</a>
        </nav>
      </aside>
      <main id="conteudo" tabIndex={-1}>
        {me.data?.demoExpiresAt && (
          <p className="banner" role="note">
            Conta de demonstração: tudo aqui some em {new Date(me.data.demoExpiresAt).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}.
          </p>
        )}
        {/* página de workspace só monta com o workspace em mãos (ao recarregar direto num endereço /w/..., a lista ainda está chegando) */}
        {ws && !workspaces.data ? (
          workspaces.error ? <p className="error" role="alert">{workspaces.error.message}</p> : <p className="muted" role="status">Carregando…</p>
        ) : ws && !current ? <p className="error" role="alert">Workspace não encontrado.</p> : <Outlet context={current} />}
      </main>
    </div>
  );
}
