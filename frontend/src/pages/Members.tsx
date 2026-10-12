import { useState, type FormEvent } from "react";
import { useNavigate, useOutletContext } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Role, type Workspace } from "../api";
import { useMe } from "../App";
import { formatDate } from "../ui/format";
import { Icon } from "../ui/icons";

const ROLE_LABEL: Record<Role, string> = { owner: "Owner", editor: "Editor", viewer: "Leitor" };
const ROLE_HELP: Record<Role, string> = {
  owner: "tudo, inclusive membros e apagar o workspace",
  editor: "cria, edita e roda fluxos e credenciais",
  viewer: "só vê fluxos e histórico",
};

export function Members() {
  const ws = useOutletContext<Workspace>();
  const me = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const isOwner = ws.role === "owner";
  const members = useQuery({ queryKey: ["members", ws.id], queryFn: () => api.members(ws.id) });
  const invites = useQuery({ queryKey: ["invites", ws.id], queryFn: () => api.invites(ws.id), enabled: isOwner });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["members", ws.id] });
    qc.invalidateQueries({ queryKey: ["invites", ws.id] });
    qc.invalidateQueries({ queryKey: ["workspaces"] });
  };

  const [role, setRole] = useState<Role>("editor");
  const [email, setEmail] = useState("");
  const [link, setLink] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [newWs, setNewWs] = useState("");

  const setMemberRole = useMutation({ mutationFn: (v: { id: string; role: Role }) => api.setRole(ws.id, v.id, v.role), onSettled: refresh });
  const remove = useMutation({
    mutationFn: (id: string) => api.removeMember(ws.id, id),
    onSuccess: (_r, id) => (id === me.data?.id ? navigate("/") : refresh()),
  });
  const byLink = useMutation({ mutationFn: () => api.inviteLink(ws.id, role), onSuccess: (r) => { setLink(r.link); refresh(); } });
  const byEmail = useMutation({ mutationFn: () => api.inviteEmail(ws.id, role, email.trim()), onSuccess: (r) => { setMessage(r.message); setEmail(""); refresh(); } });
  const revoke = useMutation({ mutationFn: (id: string) => api.revokeInvite(ws.id, id), onSuccess: refresh });
  const createWs = useMutation({ mutationFn: () => api.createWorkspace(newWs.trim()), onSuccess: (r) => { setNewWs(""); qc.invalidateQueries({ queryKey: ["workspaces"] }); navigate(`/w/${r.id}`); } });

  const error = [setMemberRole, remove, byLink, byEmail, revoke, createWs].find((m) => m.error)?.error;

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Membros</h1>
          <p className="muted">{ws.name}</p>
        </div>
      </header>
      {error && <p className="error" role="alert">{error.message}</p>}

      <section className="card">
        <div className="table-wrap">
        <table>
          <caption className="sr-only">Membros do workspace</caption>
          <thead><tr><th>Nome</th><th>E-mail</th><th>Papel</th><th>Desde</th><th><span className="sr-only">Ações</span></th></tr></thead>
          <tbody>
            {members.data?.map((m) => (
              <tr key={m.id}>
                <td>{m.name}{m.id === me.data?.id && <span className="muted"> (você)</span>}</td>
                <td className="small">{m.email}</td>
                <td>
                  {isOwner ? (
                    <select aria-label={`Papel de ${m.name}`} value={m.role} disabled={setMemberRole.isPending}
                      onChange={(e) => setMemberRole.mutate({ id: m.id, role: e.target.value as Role })}>
                      {(["owner", "editor", "viewer"] as Role[]).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                    </select>
                  ) : ROLE_LABEL[m.role]}
                </td>
                <td className="small muted">{formatDate(m.joinedAt)}</td>
                <td>
                  {(isOwner || m.id === me.data?.id) && (
                    <button type="button" className="danger ghost small"
                      onClick={() => confirm(m.id === me.data?.id ? "Sair deste workspace?" : `Remover ${m.name}?`) && remove.mutate(m.id)}>
                      {m.id === me.data?.id ? "Sair" : "Remover"}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
        <ul className="small muted">{(["owner", "editor", "viewer"] as Role[]).map((r) => <li key={r}><strong>{ROLE_LABEL[r]}:</strong> {ROLE_HELP[r]}</li>)}</ul>
      </section>

      {isOwner && (
        <section className="card stack" aria-labelledby="convidar">
          <h2 id="convidar">Convidar</h2>
          <label htmlFor="inv-role">Papel de quem entrar</label>
          <select id="inv-role" value={role} onChange={(e) => setRole(e.target.value as Role)}>
            <option value="editor">Editor</option>
            <option value="viewer">Leitor</option>
          </select>
          <div className="two-cols">
            <div className="stack">
              <h3>Por link</h3>
              <p className="small muted">Vale 7 dias e só uma vez. Mande pelo canal que preferir.</p>
              <button type="button" className="ghost" disabled={byLink.isPending} onClick={() => byLink.mutate()}><Icon name="plus" /> Gerar link</button>
              {link && (
                <div className="small">
                  <p className="warn-text">Copie agora: o link não será mostrado de novo.</p>
                  <code className="url">{link}</code>
                  <button type="button" className="ghost small" onClick={() => void navigator.clipboard.writeText(link)}><Icon name="copy" size={14} /> Copiar</button>
                </div>
              )}
            </div>
            <form className="stack" onSubmit={(e: FormEvent) => { e.preventDefault(); byEmail.mutate(); }}>
              <h3>Por e-mail</h3>
              <p className="small muted">O convite aparece quando a pessoa entrar (ou se cadastrar) com esse e-mail.</p>
              <label htmlFor="inv-email" className="sr-only">E-mail</label>
              <input id="inv-email" type="email" placeholder="pessoa@empresa.com" value={email} onChange={(e) => setEmail(e.target.value)} required />
              <button className="ghost" disabled={byEmail.isPending}>Convidar</button>
              {message && <p className="small" role="status">{message}</p>}
            </form>
          </div>
          {invites.data && invites.data.length > 0 && (
            <>
              <h3>Pendentes</h3>
              <ul className="plain">
                {invites.data.map((i) => (
                  <li key={i.id} className="row">
                    <span>{i.kind === "email" ? i.email : "Link"} · {ROLE_LABEL[i.role]} · vence {formatDate(i.expiresAt)}</span>
                    <button type="button" className="ghost small" onClick={() => revoke.mutate(i.id)}>Revogar</button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}

      <form className="card row" onSubmit={(e: FormEvent) => { e.preventDefault(); createWs.mutate(); }}>
        <label htmlFor="new-ws">Criar outro workspace</label>
        <input id="new-ws" value={newWs} onChange={(e) => setNewWs(e.target.value)} placeholder="Nome" maxLength={80} />
        <button className="ghost" disabled={!newWs.trim() || createWs.isPending}>Criar</button>
      </form>
    </>
  );
}
