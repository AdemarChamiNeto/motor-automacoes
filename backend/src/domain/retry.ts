/**
 * Falha de um passo, já classificada pela pergunta "de quem é essa falha?":
 *  - de quem configurou o fluxo (URL errada, 4xx, credencial apagada): repetir não adianta;
 *  - de um terceiro (timeout, rede, 5xx, 429): vale tentar de novo, com espera crescente.
 */
export class StepError extends Error {
  /** O que o nó tinha montado antes de falhar (vai para o histórico). */
  input?: unknown;

  constructor(
    message: string,
    readonly retryable: boolean,
    /** Espera pedida pelo serviço (Retry-After), em ms. */
    readonly retryAfterMs?: number,
    readonly output?: unknown,
  ) {
    super(message);
    this.name = "StepError";
  }
}

export const BASE_DELAY_MS = 10_000;
export const MAX_DELAY_MS = 10 * 60_000;

/**
 * Espera antes da tentativa `attempt + 1` (attempt = quantas falharam): backoff exponencial
 * 10 s, 20 s, 40 s... até 10 min, com "jitter" (metade fixa + metade aleatória) para que vários
 * fluxos que falharam juntos não voltem todos no mesmo segundo. Retry-After do serviço manda,
 * dentro do teto.
 */
export function backoffMs(attempt: number, random: () => number = Math.random, retryAfterMs?: number): number {
  const exp = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1));
  const withJitter = exp / 2 + random() * (exp / 2);
  if (retryAfterMs !== undefined && retryAfterMs > 0) return Math.min(MAX_DELAY_MS, Math.max(retryAfterMs, withJitter));
  return Math.round(withJitter);
}

/** Retry-After vem em segundos ou como data HTTP. */
export function parseRetryAfter(value: string | null, now: Date): number | undefined {
  if (!value) return undefined;
  if (/^\d+$/.test(value.trim())) return Number(value.trim()) * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now.getTime());
}
