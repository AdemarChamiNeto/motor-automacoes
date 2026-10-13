import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Credential } from "./api";
import { Inspector } from "./flow/Inspector";
import { summary } from "./flow/MotorNode";
import type { RFNode } from "./flow/convert";
import { safeReturn } from "./pages/Login";
import { duration } from "./ui/format";

const node = (type: RFNode["data"]["type"], config: Record<string, unknown>): RFNode =>
  ({ id: "n1", type: "motor", position: { x: 0, y: 0 }, data: { type, config } });

const creds: Credential[] = [
  { id: "c1", kind: "discord_webhook", name: "Discord do time", createdBy: null, createdAt: "", updatedAt: "" },
  { id: "c2", kind: "slack_webhook", name: "Slack geral", createdBy: null, createdAt: "", updatedAt: "" },
];

describe("voltar depois do login", () => {
  it("aceita caminho interno (com busca e fragmento) e recusa o que leva para fora", () => {
    expect(safeReturn("/w/1/fluxos/2?e=3")).toBe("/w/1/fluxos/2?e=3");
    expect(safeReturn("/convite#abc")).toBe("/convite#abc");
    for (const bad of ["//site.example", "/\\site.example", "https://site.example", "/\t/site.example", "javascript:alert(1)", null, ""]) {
      expect(safeReturn(bad)).toBe("/");
    }
  });
});

describe("painel do nó", () => {
  it("condição: troca de operador esconde o segundo valor quando ele não faz sentido", async () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <Inspector node={node("condition", { left: "{{trigger.body.valor}}", operator: "gt", right: "100" })} credentials={[]}
        upstreamIds={["gatilho"]} readOnly={false} onChange={onChange} onChangeType={vi.fn()} onDelete={vi.fn()} />,
    );
    expect(screen.getByLabelText("Com")).toHaveValue("100");
    await userEvent.selectOptions(screen.getByLabelText("Comparação"), "exists");
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ operator: "exists" }));
    rerender(
      <Inspector node={node("condition", { left: "x", operator: "exists", right: "" })} credentials={[]}
        upstreamIds={[]} readOnly={false} onChange={onChange} onChangeType={vi.fn()} onDelete={vi.fn()} />,
    );
    expect(screen.queryByLabelText("Com")).not.toBeInTheDocument();
  });

  it("notificação: só oferece credenciais do tipo certo e explica o modo de teste", () => {
    render(
      <Inspector node={node("notify.discord", { message: "oi", credentialId: null })} credentials={creds}
        upstreamIds={["gatilho", "grande"]} readOnly={false} onChange={vi.fn()} onChangeType={vi.fn()} onDelete={vi.fn()} />,
    );
    const select = screen.getByLabelText("Credencial");
    expect([...(select as HTMLSelectElement).options].map((o) => o.text)).toEqual(["Nenhuma (modo de teste)", "Discord do time"]);
    expect(screen.getByText(/{{steps.grande.…}}/)).toBeInTheDocument();
  });

  it("IA: só oferece a chave do provedor escolhido e trocar de provedor solta a credencial", async () => {
    const onChange = vi.fn();
    const keys: Credential[] = [
      ...creds,
      { id: "k1", kind: "gemini_key", name: "Gemini pessoal", createdBy: null, createdAt: "", updatedAt: "" },
      { id: "k2", kind: "anthropic_key", name: "Claude da empresa", createdBy: null, createdAt: "", updatedAt: "" },
    ];
    render(
      <Inspector node={node("ai", { provider: "gemini", mode: "text", credentialId: "k1", instructions: "Resuma.", input: "" })} credentials={keys}
        upstreamIds={[]} readOnly={false} onChange={onChange} onChangeType={vi.fn()} onDelete={vi.fn()} />,
    );
    const select = screen.getByLabelText("Credencial") as HTMLSelectElement;
    expect([...select.options].map((o) => o.text)).toEqual(["Nenhuma (modo de teste)", "Gemini pessoal"]);
    expect(screen.queryByLabelText(/Categorias/)).not.toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Provedor"), "anthropic");
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ provider: "anthropic", credentialId: null, model: "" }));
  });

  it("corpo JSON inválido não é gravado; o válido é", async () => {
    const onChange = vi.fn();
    render(
      <Inspector node={node("http", { method: "POST", url: "https://api.exemplo.com", headers: [] })} credentials={[]}
        upstreamIds={[]} readOnly={false} onChange={onChange} onChangeType={vi.fn()} onDelete={vi.fn()} />,
    );
    const body = screen.getByLabelText("Corpo (JSON)");
    await userEvent.type(body, "{{ \"a\": ");
    expect(screen.getByText(/JSON inválido/)).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalledWith(expect.objectContaining({ body: expect.anything() }));
    await userEvent.type(body, "1 }");
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ body: { a: 1 } }));
  });

  it("leitor vê tudo desabilitado e sem o botão de remover", () => {
    render(
      <Inspector node={node("http", { method: "GET", url: "https://x", headers: [] })} credentials={[]}
        upstreamIds={[]} readOnly onChange={vi.fn()} onChangeType={vi.fn()} onDelete={vi.fn()} />,
    );
    expect(screen.getByLabelText("URL")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Remover nó" })).not.toBeInTheDocument();
  });
});

describe("textos", () => {
  it("resumo do nó no canvas e duração legível", () => {
    expect(summary("condition", { left: "{{trigger.body.valor}}", operator: "gte", right: "10" })).toBe("{{trigger.body.valor}} é maior ou igual a 10");
    expect(summary("condition", { left: "{{x}}", operator: "exists" })).toBe("{{x}} existe");
    expect(summary("http", { method: "POST", url: "https://api" })).toBe("POST https://api");
    expect(duration(420)).toBe("420 ms");
    expect(duration(1500)).toBe("1,5 s");
    expect(duration(125_000)).toBe("2 min 5 s");
  });
});
