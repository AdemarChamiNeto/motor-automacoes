import { describe, expect, it } from "vitest";
import type { Definition } from "../api";
import { canConnect, fromFlow, newEdgeId, newNodeId, toFlow, upstream } from "./convert";

const def: Definition = {
  nodes: [
    { id: "pedido", type: "trigger.webhook", position: { x: 0, y: 0 }, data: {} },
    { id: "grande", type: "condition", position: { x: 200.4, y: 10.6 }, data: { left: "{{trigger.body.valor}}", operator: "gt", right: "500" } },
    { id: "discord", type: "notify.discord", position: { x: 400, y: 0 }, data: { message: "oi", credentialId: null } },
  ],
  edges: [
    { id: "e1", source: "pedido", target: "grande" },
    { id: "e2", source: "grande", target: "discord", sourceHandle: "true" },
  ],
};

describe("conversão definição ↔ React Flow", () => {
  it("ida e volta preserva o fluxo (posição arredondada) e o gatilho não pode ser apagado", () => {
    const { nodes, edges } = toFlow(def);
    expect(nodes[0].deletable).toBe(false);
    expect(nodes[1].deletable).toBe(true);
    expect(edges[1]).toMatchObject({ sourceHandle: "true", label: "sim" });
    const back = fromFlow(nodes, edges);
    expect(back.nodes[1].position).toEqual({ x: 200, y: 11 });
    expect(back.edges).toEqual(def.edges);
    expect(back.nodes.map((n) => n.data)).toEqual(def.nodes.map((n) => n.data));
  });

  it("ids novos legíveis e únicos", () => {
    expect(newNodeId("http", [])).toBe("http");
    expect(newNodeId("http", ["http", "http_2"])).toBe("http_3");
    expect(newNodeId("notify.discord", ["discord"])).toBe("discord_2");
    expect(newEdgeId(["e1", "e2"])).toBe("e3");
  });

  it("variáveis disponíveis: só os nós que vêm antes", () => {
    expect(upstream("discord", def.edges).sort()).toEqual(["grande", "pedido"]);
    expect(upstream("pedido", def.edges)).toEqual([]);
  });

  it("conexões: nada entra no gatilho, sem laço, sem ciclo e sem repetir", () => {
    const { nodes, edges } = toFlow(def);
    expect(canConnect({ source: "discord", target: "pedido" }, nodes, edges)).toBe(false);
    expect(canConnect({ source: "grande", target: "grande" }, nodes, edges)).toBe(false);
    expect(canConnect({ source: "discord", target: "grande" }, nodes, edges)).toBe(false); // fecharia ciclo
    expect(canConnect({ source: "grande", target: "discord", sourceHandle: "true" }, nodes, edges)).toBe(false);
    expect(canConnect({ source: "grande", target: "discord", sourceHandle: "false" }, nodes, edges)).toBe(true);
  });
});
