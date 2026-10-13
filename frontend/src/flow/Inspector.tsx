import { useEffect, useId, useState } from "react";
import type { Credential, NodeType } from "../api";
import { AI_PROVIDERS, CATALOG, CREDENTIAL_LABEL, credentialKindOf, isTrigger, OPERATORS, TRIGGER_TYPES } from "./catalog";
import type { RFNode } from "./convert";

type Props = {
  node: RFNode;
  credentials: Credential[];
  /** Ids dos nós que vêm antes deste (variáveis {{steps.X}}). */
  upstreamIds: string[];
  readOnly: boolean;
  onChange: (config: Record<string, unknown>) => void;
  onChangeType: (type: NodeType) => void;
  onDelete: () => void;
};

const TIMEZONES = ["America/Sao_Paulo", "America/Manaus", "America/Recife", "America/Noronha", "UTC", "Europe/Lisbon"];

function Field({ label, hint, children }: { label: string; hint?: string; children: (id: string) => React.ReactNode }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children(id)}
      {hint && <small className="muted">{hint}</small>}
    </div>
  );
}

/** Corpo JSON: edita como texto e só grava quando o JSON é válido. */
function JsonBody({ value, onChange, readOnly }: { value: unknown; onChange: (v: unknown) => void; readOnly: boolean }) {
  const [text, setText] = useState(() => (value === undefined ? "" : JSON.stringify(value, null, 2)));
  const [error, setError] = useState("");
  useEffect(() => setText(value === undefined ? "" : JSON.stringify(value, null, 2)), [value === undefined]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Field label="Corpo (JSON)" hint='Variáveis dentro das strings: { "id": "{{trigger.body.id}}" }. Um campo que é só uma variável mantém o tipo (número continua número).'>
      {(id) => (
        <>
          <textarea id={id} rows={6} className="mono" value={text} readOnly={readOnly} aria-invalid={!!error}
            onChange={(e) => {
              setText(e.target.value);
              if (!e.target.value.trim()) { setError(""); return onChange(undefined); }
              try { onChange(JSON.parse(e.target.value)); setError(""); } catch { setError("JSON inválido (o que vale é a última versão válida)"); }
            }} />
          {error && <small className="error">{error}</small>}
        </>
      )}
    </Field>
  );
}

/** Categorias, uma por linha: edita como texto e grava a lista sem linhas vazias. */
function Categories({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [text, setText] = useState(() => value.join("\n"));
  return (
    <Field label="Categorias (uma por linha)" hint="A IA é obrigada a responder uma delas. Use na condição: {{steps.ID.category}} é igual a urgente.">
      {(id) => (
        <textarea id={id} rows={4} value={text} onChange={(e) => {
          setText(e.target.value);
          onChange(e.target.value.split("\n").map((s) => s.trim()).filter(Boolean));
        }} />
      )}
    </Field>
  );
}

export function Inspector({ node, credentials, upstreamIds, readOnly, onChange, onChangeType, onDelete }: Props) {
  const { type, config: c } = node.data;
  const spec = CATALOG[type];
  const set = (patch: Record<string, unknown>) => onChange({ ...c, ...patch });
  const str = (k: string) => String(c[k] ?? "");
  const kind = credentialKindOf(type, c);
  const options = kind ? credentials.filter((x) => x.kind === kind) : [];
  const headers = (c.headers as { name: string; value: string }[] | undefined) ?? [];

  return (
    <aside className="inspector" aria-label="Configuração do nó">
      <header>
        <h2>{isTrigger(type) ? "Gatilho" : spec.label}</h2>
        <code className="muted" title="Nome do nó nas variáveis">{node.id}</code>
      </header>
      <p className="muted small">{spec.description}</p>

      <fieldset disabled={readOnly}>
        {isTrigger(type) && (
          <Field label="Tipo de gatilho">
            {(id) => (
              <select id={id} value={type} onChange={(e) => onChangeType(e.target.value as NodeType)}>
                {TRIGGER_TYPES.map((t) => <option key={t} value={t}>{CATALOG[t].label}</option>)}
              </select>
            )}
          </Field>
        )}

        {type === "trigger.schedule" && (
          <>
            <Field label="Cron (minuto hora dia mês dia-da-semana)" hint="Ex.: 0 9 * * 1-5 = 9h de segunda a sexta · */15 * * * * = a cada 15 min">
              {(id) => <input id={id} className="mono" value={str("cron")} onChange={(e) => set({ cron: e.target.value })} />}
            </Field>
            <Field label="Fuso horário">
              {(id) => (
                <select id={id} value={str("timezone") || "America/Sao_Paulo"} onChange={(e) => set({ timezone: e.target.value })}>
                  {TIMEZONES.map((t) => <option key={t}>{t}</option>)}
                </select>
              )}
            </Field>
          </>
        )}

        {type === "condition" && (
          <>
            <Field label="Valor" hint="Normalmente uma variável, como {{trigger.body.valor}}">
              {(id) => <input id={id} className="mono" value={str("left")} onChange={(e) => set({ left: e.target.value })} />}
            </Field>
            <Field label="Comparação">
              {(id) => (
                <select id={id} value={str("operator")} onChange={(e) => set({ operator: e.target.value })}>
                  {OPERATORS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              )}
            </Field>
            {!OPERATORS.find((o) => o.value === c.operator)?.unary && (
              <Field label="Com" hint="Se os dois lados forem números, compara como número">
                {(id) => <input id={id} className="mono" value={str("right")} onChange={(e) => set({ right: e.target.value })} />}
              </Field>
            )}
          </>
        )}

        {type === "http" && (
          <>
            <div className="row">
              <Field label="Método">
                {(id) => (
                  <select id={id} value={str("method") || "GET"} onChange={(e) => set({ method: e.target.value })}>
                    {["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => <option key={m}>{m}</option>)}
                  </select>
                )}
              </Field>
              <Field label="Tempo limite (ms)">
                {(id) => <input id={id} type="number" min={500} max={15000} step={500} value={Number(c.timeoutMs ?? 10000)} onChange={(e) => set({ timeoutMs: Number(e.target.value) })} />}
              </Field>
            </div>
            <Field label="URL" hint="Só http(s) e endereços públicos: rede interna é bloqueada pelo motor.">
              {(id) => <input id={id} className="mono" value={str("url")} onChange={(e) => set({ url: e.target.value })} />}
            </Field>
            <div className="field">
              <span className="label">Cabeçalhos</span>
              {headers.map((h, i) => (
                <div className="row" key={i}>
                  <input aria-label={`Nome do cabeçalho ${i + 1}`} placeholder="Nome" value={h.name}
                    onChange={(e) => set({ headers: headers.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} />
                  <input aria-label={`Valor do cabeçalho ${i + 1}`} placeholder="Valor" className="mono" value={h.value}
                    onChange={(e) => set({ headers: headers.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })} />
                  <button type="button" className="ghost" aria-label={`Remover cabeçalho ${i + 1}`} onClick={() => set({ headers: headers.filter((_, j) => j !== i) })}>×</button>
                </div>
              ))}
              <button type="button" className="ghost small" onClick={() => set({ headers: [...headers, { name: "", value: "" }] })}>+ cabeçalho</button>
            </div>
            {str("method") !== "GET" && str("method") !== "DELETE" && (
              <JsonBody value={c.body} readOnly={readOnly} onChange={(body) => { const { body: _old, ...rest } = c; onChange(body === undefined ? rest : { ...rest, body }); }} />
            )}
          </>
        )}

        {type === "ai" && (() => {
          const provider = AI_PROVIDERS.find((p) => p.value === c.provider) ?? AI_PROVIDERS[0];
          const listId = `modelos-${node.id}`;
          return (
            <>
              <div className="row">
                <Field label="Provedor">
                  {(id) => (
                    // trocar de provedor solta a credencial: a chave de um não serve no outro
                    <select id={id} value={provider.value} onChange={(e) => set({ provider: e.target.value, model: "", credentialId: null })}>
                      {AI_PROVIDERS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                    </select>
                  )}
                </Field>
                <Field label="Modo">
                  {(id) => (
                    <select id={id} value={str("mode") || "text"} onChange={(e) => set({ mode: e.target.value })}>
                      <option value="text">Texto</option>
                      <option value="category">Categoria</option>
                    </select>
                  )}
                </Field>
              </div>
              <Field label="Modelo" hint={`Vazio = ${provider.defaultModel} (o mais barato e rápido).`}>
                {(id) => (
                  <>
                    <input id={id} className="mono" list={listId} placeholder={provider.defaultModel} value={str("model")} onChange={(e) => set({ model: e.target.value.trim() })} />
                    <datalist id={listId}>{provider.models.map((m) => <option key={m} value={m} />)}</datalist>
                  </>
                )}
              </Field>
              <Field label="Instruções" hint="O que a IA deve fazer. Texto fixo: aqui as {{variáveis}} não são trocadas, para que dados de fora não virem ordens.">
                {(id) => <textarea id={id} rows={4} value={str("instructions")} onChange={(e) => set({ instructions: e.target.value })} />}
              </Field>
              <Field label="Dados para analisar" hint="Com variáveis, ex.: {{trigger.body.mensagem}}. Vão separados das instruções e a IA é avisada para não obedecer ao que estiver neles.">
                {(id) => <textarea id={id} rows={3} className="mono" value={str("input")} onChange={(e) => set({ input: e.target.value })} />}
              </Field>
              {c.mode === "category" && (
                <Categories key={node.id} value={(c.categories as string[] | undefined) ?? []} onChange={(categories) => set({ categories })} />
              )}
              <div className="row">
                <Field label="Limite de tokens">
                  {(id) => <input id={id} type="number" min={50} max={1000} step={50} value={Number(c.maxTokens ?? 400)} onChange={(e) => set({ maxTokens: Number(e.target.value) })} />}
                </Field>
                <Field label="Tempo limite (ms)">
                  {(id) => <input id={id} type="number" min={1000} max={30000} step={1000} value={Number(c.timeoutMs ?? 20000)} onChange={(e) => set({ timeoutMs: Number(e.target.value) })} />}
                </Field>
              </div>
            </>
          );
        })()}

        {type === "notify.telegram" && (
          <Field label="Chat ID" hint="Número do chat (fale com o bot e use o getUpdates) ou @canal">
            {(id) => <input id={id} className="mono" value={str("chatId")} onChange={(e) => set({ chatId: e.target.value })} />}
          </Field>
        )}

        {type.startsWith("notify.") && (
          <Field label="Mensagem" hint="Use variáveis: Pedido {{trigger.body.id}} de R$ {{trigger.body.valor}}">
            {(id) => <textarea id={id} rows={4} value={str("message")} onChange={(e) => set({ message: e.target.value })} />}
          </Field>
        )}

        {kind && (
          <Field label={type === "http" ? "Credencial (opcional)" : "Credencial"}
            hint={type === "http" ? "Adiciona o cabeçalho de autenticação guardado com criptografia."
              : type === "ai" ? "Sem chave, o nó roda em modo de teste: o histórico mostra o que seria enviado, sem chamar a IA."
              : "Sem credencial, o nó roda em modo de teste: a mensagem só aparece no histórico."}>
            {(id) => (
              <select id={id} value={str("credentialId")} onChange={(e) => set({ credentialId: e.target.value || null })}>
                <option value="">{type === "http" ? "Nenhuma" : "Nenhuma (modo de teste)"}</option>
                {options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
              </select>
            )}
          </Field>
        )}
        {kind && options.length === 0 && <small className="muted">Nenhuma credencial do tipo “{CREDENTIAL_LABEL[kind]}” neste workspace ainda.</small>}

        {"attempts" in c || spec.credentialKind ? (
          <Field label="Tentativas" hint="Repete só falhas temporárias (timeout, 5xx, 429), com espera crescente. Erro 4xx não repete.">
            {(id) => (
              <select id={id} value={Number(c.attempts ?? 3)} onChange={(e) => set({ attempts: Number(e.target.value) })}>
                {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n === 1 ? "1 (sem repetir)" : n}</option>)}
              </select>
            )}
          </Field>
        ) : null}
      </fieldset>

      <details className="vars">
        <summary>Variáveis disponíveis</summary>
        <ul className="mono small">
          <li>{"{{trigger.body.…}}"} <span className="muted">corpo recebido (webhook / entrada do teste)</span></li>
          {type === "trigger.webhook" || upstreamIds.length ? <li>{"{{trigger.query.…}}"} <span className="muted">parâmetros da URL do webhook</span></li> : null}
          {upstreamIds.map((u) => (
            <li key={u}>{`{{steps.${u}.…}}`} <span className="muted">saída do nó {u} (HTTP: .status, .body · IA: .text ou .category)</span></li>
          ))}
          <li>{"{{execution.id}}"} · {"{{workflow.name}}"}</li>
        </ul>
      </details>

      {!readOnly && !isTrigger(type) && (
        <button type="button" className="danger ghost" onClick={onDelete}>Remover nó</button>
      )}
    </aside>
  );
}
