import { useState, type FormEvent } from "react";
import { useOutletContext } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, type CredentialKind, type CredentialSecret, type Workspace } from "../api";
import { CREDENTIAL_LABEL } from "../flow/catalog";
import { formatDate } from "../ui/format";

const HELP: Record<CredentialKind, string> = {
  discord_webhook: "No Discord: Configurações do canal → Integrações → Webhooks → Novo webhook → Copiar URL.",
  slack_webhook: "No Slack: crie um app com Incoming Webhooks e copie a URL (https://hooks.slack.com/services/...).",
  telegram_bot: "Fale com o @BotFather no Telegram, use /newbot e cole o token que ele entrega.",
  http_header: "Para APIs com token: nome do cabeçalho (ex.: Authorization) e o valor (ex.: Bearer abc...).",
  anthropic_key: "No console da Anthropic (platform.claude.com): API Keys → Create Key. A chave começa com sk-ant- e cada chamada é cobrada na sua conta.",
  gemini_key: "No Google AI Studio (aistudio.google.com): Get API key → Create API key. Tem cota gratuita (no plano grátis o Google pode usar os dados para melhorar os modelos).",
};

export function Credentials() {
  const ws = useOutletContext<Workspace>();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["credentials", ws.id], queryFn: () => api.credentials(ws.id) });
  const canEdit = ws.role !== "viewer";
  const [kind, setKind] = useState<CredentialKind>("discord_webhook");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [header, setHeader] = useState("Authorization");
  const [value, setValue] = useState("");
  const [key, setKey] = useState("");

  const secret = (): CredentialSecret =>
    kind === "telegram_bot" ? { kind, token }
      : kind === "http_header" ? { kind, header, value }
      : kind === "anthropic_key" || kind === "gemini_key" ? { kind, key }
      : { kind, url };

  const create = useMutation({
    mutationFn: () => api.createCredential(ws.id, name.trim(), secret()),
    onSuccess: () => {
      setName(""); setUrl(""); setToken(""); setValue(""); setKey("");
      qc.invalidateQueries({ queryKey: ["credentials", ws.id] });
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteCredential(ws.id, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["credentials", ws.id] }),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };
  const fieldError = (field: string) =>
    create.error instanceof ApiError ? (create.error.details as { field?: string; message: string }[] | undefined)?.find((d) => d.field?.endsWith(field))?.message : undefined;

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Credenciais</h1>
          <p className="muted">Guardadas com criptografia (AES-256-GCM). Depois de salvas, ninguém vê o segredo de novo, nem o owner: só o motor usa na hora de rodar.</p>
        </div>
      </header>

      <div className="two-cols">
        <section className="card" aria-labelledby="lista-cred">
          <h2 id="lista-cred">Do workspace</h2>
          {list.isPending ? <p className="muted">Carregando…</p> : list.data?.length ? (
            <div className="table-wrap"><table>
              <thead><tr><th>Nome</th><th>Tipo</th><th>Criada</th>{canEdit && <th><span className="sr-only">Ações</span></th>}</tr></thead>
              <tbody>
                {list.data.map((c) => (
                  <tr key={c.id}>
                    <td>{c.name}</td>
                    <td className="small">{CREDENTIAL_LABEL[c.kind]}</td>
                    <td className="small muted">{formatDate(c.createdAt)}{c.createdBy && ` · ${c.createdBy}`}</td>
                    {canEdit && (
                      <td><button type="button" className="danger ghost small" disabled={remove.isPending}
                        onClick={() => confirm(`Apagar a credencial "${c.name}"? Fluxos que usam ela vão falhar até você trocar.`) && remove.mutate(c.id)}>Apagar</button></td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table></div>
          ) : <p className="muted">Nenhuma ainda. Sem credencial, as notificações e a IA rodam em modo de teste.</p>}
          {remove.error && <p className="error" role="alert">{remove.error.message}</p>}
        </section>

        {canEdit && (
          <form className="card stack" onSubmit={submit} aria-labelledby="nova-cred">
            <h2 id="nova-cred">Nova credencial</h2>
            <label htmlFor="c-kind">Tipo</label>
            <select id="c-kind" value={kind} onChange={(e) => setKind(e.target.value as CredentialKind)}>
              {(Object.keys(CREDENTIAL_LABEL) as CredentialKind[]).map((k) => <option key={k} value={k}>{CREDENTIAL_LABEL[k]}</option>)}
            </select>
            <small className="muted">{HELP[kind]}</small>
            <label htmlFor="c-name">Nome</label>
            <input id="c-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} placeholder="Ex.: Canal #vendas" />
            {(kind === "discord_webhook" || kind === "slack_webhook") && (
              <>
                <label htmlFor="c-url">URL do webhook</label>
                <input id="c-url" type="url" className="mono" value={url} onChange={(e) => setUrl(e.target.value)} required autoComplete="off" aria-invalid={!!fieldError("url")} />
              </>
            )}
            {kind === "telegram_bot" && (
              <>
                <label htmlFor="c-token">Token do bot</label>
                <input id="c-token" type="password" className="mono" value={token} onChange={(e) => setToken(e.target.value)} required autoComplete="off" />
              </>
            )}
            {kind === "http_header" && (
              <>
                <label htmlFor="c-header">Cabeçalho</label>
                <input id="c-header" className="mono" value={header} onChange={(e) => setHeader(e.target.value)} required />
                <label htmlFor="c-value">Valor</label>
                <input id="c-value" type="password" className="mono" value={value} onChange={(e) => setValue(e.target.value)} required autoComplete="off" />
              </>
            )}
            {(kind === "anthropic_key" || kind === "gemini_key") && (
              <>
                <label htmlFor="c-key">Chave de API</label>
                <input id="c-key" type="password" className="mono" value={key} onChange={(e) => setKey(e.target.value)} required autoComplete="off" />
              </>
            )}
            {create.error && <p className="error" role="alert">{fieldError("url") ?? fieldError("token") ?? fieldError("header") ?? fieldError("key") ?? create.error.message}</p>}
            <button className="primary" disabled={create.isPending}>{create.isPending ? "Salvando…" : "Salvar credencial"}</button>
          </form>
        )}
      </div>
    </>
  );
}
