import { useState, type FormEvent } from "react";
import { Link, useNavigate, useOutletContext } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Workspace } from "../api";
import { relative, StatusBadge, TRIGGER_LABEL } from "../ui/format";
import { Icon } from "../ui/icons";

export function Workflows() {
  const ws = useOutletContext<Workspace>();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const list = useQuery({ queryKey: ["workflows", ws.id], queryFn: () => api.workflows(ws.id), refetchInterval: 10_000 });
  const [name, setName] = useState("");
  const canEdit = ws.role !== "viewer";

  const create = useMutation({
    mutationFn: () => api.createWorkflow(ws.id, name.trim()),
    onSuccess: (r) => navigate(`/w/${ws.id}/fluxos/${r.id}`),
  });
  const toggle = useMutation({
    mutationFn: (v: { id: string; active: boolean }) => api.setActive(ws.id, v.id, v.active),
    onSettled: () => qc.invalidateQueries({ queryKey: ["workflows", ws.id] }),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) create.mutate();
  };

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Fluxos</h1>
          <p className="muted">{ws.name} · você é <strong>{ws.role}</strong></p>
        </div>
        {canEdit && (
          <form className="row" onSubmit={submit}>
            <label htmlFor="novo" className="sr-only">Nome do novo fluxo</label>
            <input id="novo" placeholder="Nome do novo fluxo" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
            <button className="primary" disabled={!name.trim() || create.isPending}><Icon name="plus" /> Criar</button>
          </form>
        )}
      </header>
      {create.error && <p className="error" role="alert">{create.error.message}</p>}
      {toggle.error && <p className="error" role="alert">{toggle.error.message}</p>}

      {list.isPending ? <p className="muted" role="status">Carregando…</p> : list.error ? <p className="error" role="alert">{list.error.message}</p> : list.data.length === 0 ? (
        <div className="empty card">
          <p>Nenhum fluxo ainda.</p>
          {canEdit && <p className="muted">Dê um nome acima e clique em Criar.</p>}
        </div>
      ) : (
        <ul className="flow-list">
          {list.data.map((f) => (
            <li key={f.id} className="card flow-card">
              <div className="flow-main">
                <Link to={`/w/${ws.id}/fluxos/${f.id}`} className="flow-name">{f.name}</Link>
                <p className="muted small">{f.description || "Sem descrição"}</p>
                <p className="small">
                  {f.publishedVersion ? <>Versão {f.publishedVersion}</> : <span className="badge warn">Rascunho, nunca publicado</span>}
                  {f.triggerKind && <> · gatilho: {TRIGGER_LABEL[f.triggerKind]}</>}
                </p>
              </div>
              <div className="flow-side">
                <div className="small">
                  <StatusBadge status={f.lastStatus} /> {f.lastRunAt && <span className="muted">{relative(f.lastRunAt)}</span>}
                </div>
                <div className="row">
                  <Link className="button ghost small" to={`/w/${ws.id}/fluxos/${f.id}/execucoes`}><Icon name="history" size={16} /> Histórico</Link>
                  {f.triggerKind && (
                    <label className="switch" title={canEdit ? undefined : "Leitores não podem ligar ou desligar"}>
                      <input type="checkbox" aria-label={`Ligar o fluxo ${f.name}`} checked={f.isActive} disabled={!canEdit || toggle.isPending}
                        onChange={(e) => toggle.mutate({ id: f.id, active: e.target.checked })} />
                      <span>{f.isActive ? "Ligado" : "Desligado"}</span>
                    </label>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
