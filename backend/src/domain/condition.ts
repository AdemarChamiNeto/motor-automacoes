import type { Operator } from "./definition.js";

const asNumber = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
};

const asText = (v: unknown): string => (v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));

/**
 * Compara o valor da esquerda (já resolvido, com o tipo original) com o texto da direita.
 * Números são comparados como números quando os dois lados são numéricos ("10" > "9").
 * Comparação de ordem com algo que não é número dá falso, em vez de comparar texto sem querer.
 */
export function evaluate(left: unknown, operator: Operator, right: unknown): boolean {
  switch (operator) {
    case "exists":
      return left !== undefined && left !== null && left !== "";
    case "not_exists":
      return left === undefined || left === null || left === "";
    case "contains":
    case "not_contains": {
      const has = Array.isArray(left) ? left.some((item) => asText(item) === asText(right)) : asText(left).includes(asText(right));
      return operator === "contains" ? has : !has;
    }
    case "eq":
    case "neq": {
      const a = asNumber(left), b = asNumber(right);
      const same = a !== null && b !== null ? a === b : asText(left) === asText(right);
      return operator === "eq" ? same : !same;
    }
    default: {
      const a = asNumber(left), b = asNumber(right);
      if (a === null || b === null) return false;
      if (operator === "gt") return a > b;
      if (operator === "gte") return a >= b;
      if (operator === "lt") return a < b;
      return a <= b;
    }
  }
}
