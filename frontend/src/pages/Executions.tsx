import { useMemo, useState } from "react";
import { Link, useOutletContext, useParams, useSearchParams } from "react-router";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Background, ReactFlow, ReactFlowProvider } from "@xyflow/react";
import { api, type ExecStatus, type Execution, type Workspace } from "../api";
import { labelOf, toFlow } from "../flow/convert";
import { nodeTypes } from "../flow/MotorNode";
import { duration, formatDate, relative, STATUS_LABEL, StatusBadge, TRIGGER_LABEL } from "../ui/format";

const LIVE: ExecStatus[] = ["queued", "running"];
const FILTERS: (ExecStatus | "")[] = ["", "succeeded", "failed", "running", "queued", "canceled"];

export function Executions() {
  const ws = useOutletContext<Workspace>();
  const { id = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const [status, setStatus] = useState<ExecStatus | "">("");
  const selectedId = params.get("e");
  const wf = useQuery({ queryKey: ["workflow", ws.id, id], queryFn: () => api.workflow(ws.id, id) });

  const list = useInfiniteQuery({
    queryKey: ["executions", ws.id, id, status],
    queryFn: ({ pageParam }) => api.executions(ws.id, id, { status: status || undefined, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    // enquanto alguma execução está na fila ou rodando, atualiza sozinho
    refetchInterval: (q) => (q.state.data?.pages.some((p) => p.items.some((e) => LIVE.includes(e.status))) ? 2000 : 15_000),
  });
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <>
      <header className="page-head">
        <div>
          <p className="small"><Link to={`/w/${ws.id}`}>Fluxos</Link> / <Link to={`/w/${ws.id}/fluxos/${id}`}>{wf.data?.name ?? "…"}</Link></p>
          <h1>Histórico de execuções</h1>
        </div>
        <label className="row">
          <span className="small">Status</span>
          <select value={status} onChange={(e) => setStatus(e.target.value as ExecStatus | "")}>
            {FILTERS.map((s) => <option key={s} value={s}>{s ? STATUS_LABEL[s] : "Todos"}</option>)}
          </select>
        </label>
      </header>

      <div className="exec-layout">
        <section aria-label="Execuções" className="exec-list">
          {list.isPending ? <p className="muted" role="status">Carregando…</p> : list.error ? <p className="error" role="alert">{list.error.message}</p> : items.length === 0 ? (
            <p className="muted card">Nenhuma execução{status ? " com esse status" : ""} ainda. Use “Executar agora” no editor.</p>
          ) : (
            <ul>
              {items.map((e) => (
                <li key={e.id}>
                  <button type="button" className={`exec-item ${e.id === selectedId ? "active" : ""}`} aria-current={e.id === selectedId}
                    onClick={() => setParams({ e: e.id })}>
                    <StatusBadge status={e.status} />
                    <span className="small">{TRIGGER_LABEL[e.trigger]} · v{e.version}</span>
                    <span className="small muted" title={formatDate(e.createdAt)}>{relative(e.createdAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {list.hasNextPage && (
            <button type="button" className="ghost" disabled={list.isFetchingNextPage} onClick={() => list.fetchNextPage()}>
              {list.isFetchingNextPage ? "Carregando…" : "Carregar mais"}
            </button>
          )}
        </section>

        <section aria-label="Detalhe da execução" className="exec-detail">
          {selectedId ? <Detail ws={ws} workflowId={id} execId={selectedId} /> : <p className="muted card">Escolha uma execução para ver cada passo.</p>}
        </section>
      </div>
    </>
  );
}

function Detail({ ws, workflowId, execId }: { ws: Workspace; workflowId: string; execId: string }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["execution", ws.id, workflowId, execId],
    queryFn: () => api.execution(ws.id, workflowId, execId),
    refetchInterval: (query) => (query.state.data && LIVE.includes(query.state.data.status) ? 1500 : false),
  });
  const cancel = useMutation({
    mutationFn: () => api.cancel(ws.id, workflowId, execId),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["execution", ws.id, workflowId, execId] });
      qc.invalidateQueries({ queryKey: ["executions", ws.id, workflowId] });
    },
  });
  if (q.isPending) return <p className="muted" role="status">Carregando…</p>;
  if (q.error) return <p className="error" role="alert">{q.error.message}</p>;
  const e = q.data;

  return (
    <div className="card">
      <div className="row spread">
        <h2>Execução <StatusBadge status={e.status} /></h2>
        {LIVE.includes(e.status) && ws.role !== "viewer" && (
          <button type="button" className="danger ghost small" disabled={cancel.isPending} onClick={() => cancel.mutate()}>Cancelar</button>
        )}
      </div>
      <dl className="facts">
        <div><dt>Gatilho</dt><dd>{TRIGGER_LABEL[e.trigger]}</dd></div>
        <div><dt>Versão</dt><dd>v{e.version}</dd></div>
        <div><dt>Criada</dt><dd>{formatDate(e.createdAt)}</dd></div>
        <div><dt>Duração</dt><dd>{e.startedAt && e.finishedAt ? duration(new Date(e.finishedAt).getTime() - new Date(e.startedAt).getTime()) : "—"}</dd></div>
        <div><dt>Vezes que entrou no worker</dt><dd>{e.attempt}</dd></div>
        {e.status === "queued" && e.attempt > 0 && <div><dt>Próxima tentativa</dt><dd>{relative(e.runAt)}</dd></div>}
      </dl>
      {e.error && <p className={e.status === "queued" ? "notice warn" : "notice error"} role="status">{e.error}</p>}
      {cancel.error && <p className="error" role="alert">{cancel.error.message}</p>}

      <ReactFlowProvider><RunGraph execution={e} /></ReactFlowProvider>

      <h3>Passos</h3>
      <ol className="steps">
        {e.steps.map((s) => (
          <li key={`${s.nodeId}-${s.attempt}`} className={`step step-${s.status}`}>
            <details open={s.status === "failed"}>
              <summary>
                <StatusBadge status={s.status} /> <strong>{s.nodeId}</strong> <span className="muted small">{labelOf(s.nodeType)}</span>
                {s.attempt > 1 && <span className="small"> · tentativa {s.attempt}</span>}
                <span className="muted small"> · {duration(s.durationMs)}</span>
              </summary>
              {s.error && <p className="error small">{s.error}</p>}
              {s.input !== null && <><h4>Entrada</h4><pre>{JSON.stringify(s.input, null, 2)}</pre></>}
              {s.output !== null && <><h4>Saída</h4><pre>{JSON.stringify(s.output, null, 2)}</pre></>}
            </details>
          </li>
        ))}
        {e.steps.length === 0 && <li className="muted">{e.status === "queued" ? "Na fila: o worker pega em instantes." : "Nenhum passo registrado."}</li>}
      </ol>
      <details>
        <summary className="small">Entrada recebida</summary>
        <pre>{JSON.stringify(e.input, null, 2)}</pre>
      </details>
    </div>
  );
}

/** O fluxo da versão que rodou, com cada nó colorido pelo resultado do último passo. */
function RunGraph({ execution }: { execution: Execution }) {
  const { nodes, edges } = useMemo(() => {
    const g = toFlow(execution.definition);
    const last = new Map<string, Execution["steps"][number]>();
    for (const s of execution.steps) last.set(s.nodeId, s);
    return {
      nodes: g.nodes.map((n) => ({
        ...n, draggable: false, selectable: false,
        data: { ...n.data, stepStatus: last.get(n.id)?.status ?? ("pending" as const) },
      })),
      edges: g.edges,
    };
  }, [execution]);
  return (
    <div className="run-graph" aria-label="Fluxo desta execução">
      <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView minZoom={0.2} fitViewOptions={{ padding: 0.15 }}
        nodesConnectable={false} panOnScroll zoomOnScroll={false} proOptions={{ hideAttribution: false }}>
        <Background gap={20} />
      </ReactFlow>
    </div>
  );
}
