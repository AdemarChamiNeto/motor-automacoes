import type { ExecStatus } from "../api";

const dt = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "medium" });
const rel = new Intl.RelativeTimeFormat("pt-BR", { numeric: "auto" });

export const formatDate = (iso: string | null | undefined) => (iso ? dt.format(new Date(iso)) : "—");

/** "há 3 min", "em 2 h" */
export function relative(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "—";
  const diff = (new Date(iso).getTime() - now) / 1000;
  const abs = Math.abs(diff);
  if (abs < 45) return diff < 0 ? "agora há pouco" : "em instantes";
  if (abs < 3600) return rel.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return rel.format(Math.round(diff / 3600), "hour");
  return rel.format(Math.round(diff / 86400), "day");
}

export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1).replace(".", ",")} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
}

export const STATUS_LABEL: Record<ExecStatus, string> = {
  queued: "Na fila",
  running: "Rodando",
  succeeded: "Sucesso",
  failed: "Falhou",
  canceled: "Cancelada",
};

export const TRIGGER_LABEL = { webhook: "Webhook", schedule: "Agendamento", manual: "Manual" } as const;

export function StatusBadge({ status }: { status: ExecStatus | "skipped" | null }) {
  if (!status) return <span className="badge">Nunca rodou</span>;
  const label = status === "skipped" ? "Pulado" : STATUS_LABEL[status];
  return <span className={`badge s-${status}`}>{label}</span>;
}
