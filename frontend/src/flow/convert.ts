import type { Edge, Node } from "@xyflow/react";
import type { Definition, FlowEdge, FlowNode, NodeType } from "../api";
import { CATALOG, isTrigger } from "./catalog";

/** Dados de cada nó no React Flow: o tipo do motor e a configuração. */
export type MotorData = {
  type: NodeType;
  config: Record<string, unknown>;
  /** Problemas apontados pela validação do servidor. */
  problems?: string[];
  /** Status do passo (na tela do histórico). */
  stepStatus?: "succeeded" | "failed" | "skipped" | "pending";
};
export type RFNode = Node<MotorData, "motor">;

/** Definição (formato do motor) → nós e arestas do React Flow. */
export function toFlow(def: Definition): { nodes: RFNode[]; edges: Edge[] } {
  return {
    nodes: def.nodes.map((n) => ({
      id: n.id,
      type: "motor",
      position: n.position ?? { x: 0, y: 0 },
      data: { type: n.type, config: n.data ?? {} },
      deletable: !isTrigger(n.type), // o gatilho troca de tipo, mas não some
    })),
    edges: def.edges.map((e) => toFlowEdge(e)),
  };
}

export const toFlowEdge = (e: FlowEdge): Edge => ({
  id: e.id,
  source: e.source,
  target: e.target,
  sourceHandle: e.sourceHandle ?? null,
  label: e.sourceHandle === "true" ? "sim" : e.sourceHandle === "false" ? "não" : undefined,
  className: e.sourceHandle ? `edge-${e.sourceHandle}` : undefined,
});

/** React Flow → definição para salvar. Posição arredondada: o JSON não muda por meio pixel. */
export function fromFlow(nodes: RFNode[], edges: Edge[]): Definition {
  return {
    nodes: nodes.map((n): FlowNode => ({
      id: n.id,
      type: n.data.type,
      position: { x: Math.round(n.position.x), y: Math.round(n.position.y) },
      data: n.data.config,
    })),
    edges: edges.map((e): FlowEdge => ({
      id: e.id,
      source: e.source,
      target: e.target,
      ...(e.sourceHandle === "true" || e.sourceHandle === "false" ? { sourceHandle: e.sourceHandle } : {}),
    })),
  };
}

/** Id legível e único para um nó novo: "http", "http_2", "http_3"... (aparece nas variáveis {{steps.http...}}). */
export function newNodeId(type: NodeType, taken: Iterable<string>): string {
  const base = type.replace(/^notify\./, "").replace(/^trigger\./, "gatilho_").replace(/[^a-z0-9_]/gi, "_");
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) if (!used.has(`${base}_${i}`)) return `${base}_${i}`;
}

export const newEdgeId = (taken: Iterable<string>): string => {
  const used = new Set(taken);
  for (let i = 1; ; i++) if (!used.has(`e${i}`)) return `e${i}`;
};

/** Nós que vêm antes de `nodeId` (as variáveis {{steps.X...}} que ele pode usar). */
export function upstream(nodeId: string, edges: { source: string; target: string }[]): string[] {
  const seen = new Set<string>();
  const stack = [nodeId];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const e of edges) if (e.target === cur && !seen.has(e.source)) {
      seen.add(e.source);
      stack.push(e.source);
    }
  }
  return [...seen];
}

/** Uma conexão nova é válida? (sem laço no mesmo nó, nada entrando no gatilho, sem repetir). */
export function canConnect(
  c: { source: string | null; target: string | null; sourceHandle?: string | null },
  nodes: RFNode[],
  edges: Edge[],
): boolean {
  if (!c.source || !c.target || c.source === c.target) return false;
  const target = nodes.find((n) => n.id === c.target);
  if (!target || isTrigger(target.data.type)) return false;
  if (edges.some((e) => e.source === c.source && e.target === c.target && (e.sourceHandle ?? null) === (c.sourceHandle ?? null))) return false;
  // não deixa fechar ciclo: o alvo não pode já estar antes da origem
  return !upstream(c.source, edges).includes(c.target);
}

export const labelOf = (t: NodeType) => CATALOG[t]?.label ?? t;
