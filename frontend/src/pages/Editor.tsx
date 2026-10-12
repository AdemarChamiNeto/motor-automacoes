import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  addEdge, Background, Controls, MiniMap, ReactFlow, ReactFlowProvider, useEdgesState, useNodesState, useReactFlow,
  type Connection, type Edge,
} from "@xyflow/react";
import { api, ApiError, type NodeType, type Problem, type Workflow } from "../api";
import { useWorkspaces } from "../App";
import { CATALOG, PALETTE } from "../flow/catalog";
import { canConnect, fromFlow, newEdgeId, newNodeId, toFlow, toFlowEdge, upstream, type RFNode } from "../flow/convert";
import { Inspector } from "../flow/Inspector";
import { nodeTypes } from "../flow/MotorNode";
import { Icon, NODE_ICON } from "../ui/icons";

export function Editor() {
  const { ws = "", id = "" } = useParams();
  const wf = useQuery({ queryKey: ["workflow", ws, id], queryFn: () => api.workflow(ws, id), refetchOnWindowFocus: false });
  const workspaces = useWorkspaces();
  const role = workspaces.data?.find((w) => w.id === ws)?.role;

  if (wf.isPending || !role) return <p className="center muted" role="status">Carregando o fluxo…</p>;
  if (wf.error) return <p className="center error" role="alert">{wf.error.message} · <Link to={`/w/${ws}`}>Voltar</Link></p>;
  return (
    <ReactFlowProvider>
      <Canvas key={wf.data.id} ws={ws} initial={wf.data} readOnly={role === "viewer"} />
    </ReactFlowProvider>
  );
}

type Notice = { kind: "ok" | "error"; text: string } | null;

function Canvas({ ws, initial, readOnly }: { ws: string; initial: Workflow; readOnly: boolean }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const flow = useReactFlow();
  const start = useMemo(() => toFlow(initial.draft), [initial.draft]);
  const [nodes, setNodes, onNodesChange] = useNodesState<RFNode>(start.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(start.edges);
  const [name, setName] = useState(initial.name);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [problems, setProblems] = useState<Problem[]>(initial.problems);
  const [notice, setNotice] = useState<Notice>(null);
  const [webhookUrl, setWebhookUrl] = useState<string | null>(null);
  const [runOpen, setRunOpen] = useState(false);
  const saved = useRef(JSON.stringify({ name: initial.name, draft: fromFlow(start.nodes, start.edges) }));

  const credentials = useQuery({ queryKey: ["credentials", ws], queryFn: () => api.credentials(ws) });
  const info = useQuery({ queryKey: ["workflow", ws, initial.id], queryFn: () => api.workflow(ws, initial.id), initialData: initial, refetchOnWindowFocus: false });

  const current = () => ({ name: name.trim(), draft: fromFlow(nodes, edges) });
  const dirty = JSON.stringify(current()) !== saved.current;

  // aviso ao sair com alterações não salvas
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);

  // problemas do servidor aparecem nos nós
  useEffect(() => {
    setNodes((ns) => ns.map((n) => {
      const p = problems.filter((x) => x.nodeId === n.id).map((x) => x.message);
      return (n.data.problems?.join() ?? "") === p.join() ? n : { ...n, data: { ...n.data, problems: p } };
    }));
  }, [problems, setNodes]);

  const save = useMutation({
    mutationFn: async () => {
      const body = current();
      const r = await api.saveWorkflow(ws, initial.id, body);
      saved.current = JSON.stringify(body);
      setProblems(r.problems);
      return r;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["workflow", ws, initial.id] });
      qc.invalidateQueries({ queryKey: ["workflows", ws] });
    },
  });

  const publish = useMutation({
    mutationFn: async () => {
      if (dirty) await save.mutateAsync();
      return api.publish(ws, initial.id);
    },
    onSuccess: (r) => {
      setProblems([]);
      setNotice({ kind: "ok", text: `Versão ${r.version} publicada. É ela que roda a partir de agora.` });
      if (r.webhookUrl) setWebhookUrl(r.webhookUrl);
      qc.invalidateQueries({ queryKey: ["workflow", ws, initial.id] });
      qc.invalidateQueries({ queryKey: ["workflows", ws] });
    },
    onError: (e) => {
      if (e instanceof ApiError && e.status === 422) setProblems(e.problems);
      setNotice({ kind: "error", text: e.message });
    },
  });

  const toggle = useMutation({
    mutationFn: (active: boolean) => api.setActive(ws, initial.id, active),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["workflow", ws, initial.id] }),
    onError: (e) => setNotice({ kind: "error", text: e.message }),
  });

  const rotate = useMutation({
    mutationFn: () => api.rotateWebhook(ws, initial.id),
    onSuccess: (r) => setWebhookUrl(r.webhookUrl),
    onError: (e) => setNotice({ kind: "error", text: e.message }),
  });

  // Ctrl+S salva
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (!readOnly && dirty && !save.isPending) save.mutate();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [dirty, readOnly, save]);

  const onConnect = useCallback((c: Connection) => {
    setEdges((es) => (canConnect(c, nodes, es)
      ? addEdge(toFlowEdge({ id: newEdgeId(es.map((e) => e.id)), source: c.source, target: c.target, sourceHandle: (c.sourceHandle as "true" | "false" | null) ?? null }), es)
      : es));
  }, [nodes, setEdges]);

  function addNode(type: NodeType) {
    const id = newNodeId(type, nodes.map((n) => n.id));
    const center = flow.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
    const node: RFNode = { id, type: "motor", position: { x: center.x - 90, y: center.y - 30 + (nodes.length % 4) * 20 }, data: { type, config: CATALOG[type].defaults() } };
    setNodes((ns) => [...ns.map((n) => ({ ...n, selected: false })), { ...node, selected: true }]);
    setSelectedId(id);
  }

  const selected = nodes.find((n) => n.id === selectedId) ?? null;
  const updateSelected = (patch: Partial<RFNode["data"]>) =>
    setNodes((ns) => ns.map((n) => (n.id === selectedId ? { ...n, data: { ...n.data, ...patch } } : n)));

  const w = info.data;
  const status = !w.publishedVersion ? "Nunca publicado" : w.hasUnpublishedChanges || dirty ? `v${w.publishedVersion} publicada · há mudanças não publicadas` : `v${w.publishedVersion} publicada`;
  const triggerType = nodes.find((n) => n.data.type.startsWith("trigger."))?.data.type;

  return (
    <div className="editor">
      <header className="editor-bar">
        <Link to={`/w/${ws}`} className="button ghost" aria-label="Voltar para os fluxos">←</Link>
        <label htmlFor="wf-name" className="sr-only">Nome do fluxo</label>
        <input id="wf-name" className="wf-name" value={name} onChange={(e) => setName(e.target.value)} readOnly={readOnly} maxLength={100} />
        <span className="muted small" role="status">{status}{dirty && " · não salvo"}</span>
        <div className="spacer" />
        <Link className="button ghost" to={`/w/${ws}/fluxos/${initial.id}/execucoes`}><Icon name="history" /> Histórico</Link>
        {!readOnly && (
          <>
            <button type="button" className="ghost" disabled={!dirty || save.isPending} onClick={() => save.mutate()} title="Ctrl+S">
              <Icon name="save" /> {save.isPending ? "Salvando…" : "Salvar"}
            </button>
            <button type="button" className="primary" disabled={publish.isPending} onClick={() => publish.mutate()}>
              <Icon name="rocket" /> {publish.isPending ? "Publicando…" : "Publicar"}
            </button>
            <button type="button" className="ghost" disabled={!w.publishedVersion} onClick={() => setRunOpen(true)}
              title={w.publishedVersion ? "Roda a versão publicada" : "Publique primeiro"}>
              <Icon name="play" /> Executar agora
            </button>
            {triggerType !== "trigger.manual" && (
              <label className="switch">
                <input type="checkbox" aria-label="Ligar o fluxo" checked={w.isActive} disabled={!w.publishedVersion || toggle.isPending} onChange={(e) => toggle.mutate(e.target.checked)} />
                <span>{w.isActive ? "Ligado" : "Desligado"}</span>
              </label>
            )}
          </>
        )}
      </header>

      {(notice || save.error) && (
        <p className={`notice ${notice?.kind === "ok" ? "ok" : "error"}`} role={notice?.kind === "ok" ? "status" : "alert"}>
          {notice?.text ?? save.error?.message}
          <button type="button" className="ghost small" aria-label="Fechar aviso" onClick={() => { setNotice(null); save.reset(); }}>×</button>
        </p>
      )}

      <div className="editor-body">
        {!readOnly && (
          <nav className="palette" aria-label="Adicionar nó">
            <span className="label">Adicionar</span>
            {PALETTE.map((t) => (
              <button type="button" key={t} className={`pal g-${CATALOG[t].group}`} onClick={() => addNode(t)} title={CATALOG[t].description}>
                <Icon name={NODE_ICON[t]} size={16} /> {CATALOG[t].label}
              </button>
            ))}
            <p className="small muted">Ligue as bolinhas para conectar. Selecione e aperte Delete para apagar.</p>
          </nav>
        )}

        <div className="canvas" aria-label="Fluxo">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            isValidConnection={(c) => canConnect(c as Connection, nodes, edges)}
            onSelectionChange={({ nodes: sel }) => setSelectedId(sel[0]?.id ?? null)}
            nodesDraggable={!readOnly}
            nodesConnectable={!readOnly}
            elementsSelectable
            deleteKeyCode={readOnly ? null : ["Delete", "Backspace"]}
            fitView
            minZoom={0.2}
            fitViewOptions={{ padding: 0.25, maxZoom: 1.1 }}
            proOptions={{ hideAttribution: false }}
          >
            <Background gap={20} />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable className="minimap" />
          </ReactFlow>
        </div>

        {selected ? (
          <Inspector
            node={selected}
            credentials={credentials.data ?? []}
            upstreamIds={upstream(selected.id, edges)}
            readOnly={readOnly}
            onChange={(config) => updateSelected({ config })}
            onChangeType={(type) => updateSelected({ type, config: CATALOG[type].defaults() })}
            onDelete={() => {
              setNodes((ns) => ns.filter((n) => n.id !== selected.id));
              setEdges((es) => es.filter((e) => e.source !== selected.id && e.target !== selected.id));
              setSelectedId(null);
            }}
          />
        ) : (
          <aside className="inspector" aria-label="Ajuda">
            <h2>Como funciona</h2>
            <ol className="small">
              <li>Configure o gatilho (clique nele).</li>
              <li>Adicione condições, chamadas HTTP e notificações e ligue os nós.</li>
              <li><strong>Salvar</strong> guarda o rascunho; <strong>Publicar</strong> cria uma versão nova, que é o que roda.</li>
              <li>Ligue o fluxo para o webhook ou o agendamento dispararem.</li>
            </ol>
            {problems.length > 0 && (
              <>
                <h3>Problemas para publicar</h3>
                <ul className="problems">
                  {problems.map((p, i) => (
                    <li key={i}>
                      {p.nodeId ? <button type="button" className="link" onClick={() => { setSelectedId(p.nodeId!); flow.fitView({ nodes: [{ id: p.nodeId! }], maxZoom: 1.2, duration: 300 }); }}>{p.nodeId}</button> : "fluxo"}: {p.message}
                    </li>
                  ))}
                </ul>
              </>
            )}
            {triggerType === "trigger.webhook" && w.publishedVersion && !readOnly && (
              <section className="webhook-box">
                <h3>URL do webhook</h3>
                {webhookUrl ? <WebhookUrl url={webhookUrl} /> : (
                  <p className="small muted">Por segurança, a URL só aparece quando é criada (no banco fica só o hash do token). Perdeu? Gere outra: a antiga para de funcionar.</p>
                )}
                <button type="button" className="ghost small" disabled={rotate.isPending} onClick={() => rotate.mutate()}>Gerar nova URL</button>
              </section>
            )}
            {w.nextRunAt && <p className="small">Próxima execução agendada: {new Date(w.nextRunAt).toLocaleString("pt-BR")}</p>}
          </aside>
        )}
      </div>

      {runOpen && (
        <RunDialog
          onClose={() => setRunOpen(false)}
          onRun={async (input) => {
            const r = await api.run(ws, initial.id, input);
            navigate(`/w/${ws}/fluxos/${initial.id}/execucoes?e=${r.executionId}`);
          }}
          example={triggerType === "trigger.webhook" ? '{\n  "id": "P-1001",\n  "cliente": "Loja Exemplo",\n  "valor": 750\n}' : "{}"}
        />
      )}
    </div>
  );
}

function WebhookUrl({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  const curl = `curl -X POST "${url}" -H "Content-Type: application/json" -d '{"id":"P-1","valor":750}'`;
  return (
    <div className="small">
      <p className="warn-text">Copie agora: ela não será mostrada de novo.</p>
      <code className="url">{url}</code>
      <button type="button" className="ghost small" onClick={() => void navigator.clipboard.writeText(url).then(() => setCopied(true))}>
        <Icon name="copy" size={14} /> {copied ? "Copiada" : "Copiar"}
      </button>
      <details><summary>Testar com curl</summary><code className="url">{curl}</code></details>
    </div>
  );
}

function RunDialog({ onClose, onRun, example }: { onClose: () => void; onRun: (input: Record<string, unknown>) => Promise<void>; example: string }) {
  const [text, setText] = useState(example);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  async function go() {
    let input: unknown;
    try {
      input = text.trim() ? JSON.parse(text) : {};
    } catch {
      return setError("JSON inválido");
    }
    if (!input || typeof input !== "object" || Array.isArray(input)) return setError("A entrada precisa ser um objeto JSON");
    setBusy(true);
    try {
      await onRun(input as Record<string, unknown>);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <dialog ref={ref} className="dialog" onClose={onClose} aria-labelledby="run-title">
      <h2 id="run-title">Executar agora</h2>
      <p className="small muted">Roda a versão publicada. A entrada vira <code>{"{{trigger.body}}"}</code>.</p>
      <label htmlFor="run-input">Entrada (JSON)</label>
      <textarea id="run-input" className="mono" rows={8} value={text} onChange={(e) => setText(e.target.value)} aria-invalid={!!error} />
      {error && <p className="error" role="alert">{error}</p>}
      <div className="row end">
        <button type="button" className="ghost" onClick={() => ref.current?.close()}>Cancelar</button>
        <button type="button" className="primary" disabled={busy} onClick={go}><Icon name="play" /> {busy ? "Enfileirando…" : "Executar"}</button>
      </div>
    </dialog>
  );
}
