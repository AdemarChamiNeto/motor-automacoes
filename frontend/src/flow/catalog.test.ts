import { describe, expect, it } from "vitest";
import { CATALOG, credentialKindOf, PALETTE } from "./catalog";
import { summary } from "./MotorNode";

describe("nó de IA", () => {
  it("a credencial aceita depende do provedor (igual ao servidor)", () => {
    expect(credentialKindOf("ai", { provider: "anthropic" })).toBe("anthropic_key");
    expect(credentialKindOf("ai", { provider: "gemini" })).toBe("gemini_key");
    expect(credentialKindOf("ai", {})).toBe("gemini_key"); // padrão do servidor
    expect(credentialKindOf("notify.slack", {})).toBe("slack_webhook");
    expect(credentialKindOf("condition", {})).toBeUndefined();
  });

  it("está na paleta e o resumo mostra provedor e modo", () => {
    expect(PALETTE).toContain("ai");
    const cfg = CATALOG.ai.defaults();
    expect(summary("ai", cfg)).toBe("Gemini · Resuma o texto em uma frase.");
    expect(summary("ai", { ...cfg, provider: "anthropic", mode: "category", categories: ["alta", "baixa"] })).toBe("Claude · categoria: alta / baixa");
  });
});
