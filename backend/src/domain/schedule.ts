import { CronExpressionParser } from "cron-parser";

/** Agendamento mais curto permitido: a demo é pública e cada execução faz chamadas de verdade. */
export const MIN_INTERVAL_MINUTES = 5;

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Próxima execução estritamente depois de `after`, no fuso do agendamento (horário de verão incluído). */
export function nextRun(cron: string, timezone: string, after: Date): Date {
  return CronExpressionParser.parse(cron, { currentDate: after, tz: timezone }).next().toDate();
}

/** Mensagem do problema, ou null se o cron for válido. */
export function validateCron(cron: string, timezone: string): string | null {
  if (!isValidTimezone(timezone)) return `fuso horário desconhecido: ${timezone}`;
  if (cron.trim().split(/\s+/).length !== 5) return "use o formato de 5 campos: minuto hora dia mês dia-da-semana";
  try {
    // confere o menor intervalo nas próximas execuções (ex.: "*/2 * * * *" roda a cada 2 min)
    const it = CronExpressionParser.parse(cron, { currentDate: new Date("2026-01-05T00:00:00Z"), tz: timezone });
    let prev = it.next().toDate().getTime();
    for (let i = 0; i < 20; i++) {
      const next = it.next().toDate().getTime();
      if (next - prev < MIN_INTERVAL_MINUTES * 60_000) return `o intervalo mínimo é de ${MIN_INTERVAL_MINUTES} minutos`;
      prev = next;
    }
    return null;
  } catch (err) {
    return `cron inválido: ${(err as Error).message}`;
  }
}
