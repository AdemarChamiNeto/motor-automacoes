import type { NodeType } from "../api";

/** Ícones em SVG (traço), sem biblioteca: herdam a cor do texto. */
const P: Record<string, string> = {
  webhook: "M9 17a3 3 0 1 1-2.8-4M15 7a3 3 0 1 1 3 3M12 10l-3 7M15 10l3.6 6.5M12 4a3 3 0 0 0-1.4 5.6M18 17H11",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7v5l3 2",
  play: "M7 4v16l13-8L7 4Z",
  branch: "M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM18 9a9 9 0 0 1-9 9",
  globe: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3Z",
  chat: "M4 5h16v11H9l-5 4V5Z",
  send: "M21 3 10 14M21 3l-7 18-4-7-7-4 18-7Z",
  hash: "M5 9h14M5 15h14M10 3 8 21M16 3l-2 18",
  key: "M15 7a4 4 0 1 1-3.9 5H3v3h3v3h3v-3h2.1A4 4 0 0 1 15 7Z",
  users: "M16 19v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1M9 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM22 19v-1a4 4 0 0 0-3-3.9M16 4.1a3 3 0 0 1 0 5.8",
  flow: "M4 6h6v4H4zM14 14h6v4h-6zM7 10v4a2 2 0 0 0 2 2h5",
  user: "M20 21v-1a5 5 0 0 0-5-5H9a5 5 0 0 0-5 5v1M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z",
  history: "M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2",
  plus: "M12 5v14M5 12h14",
  logout: "M15 4h4v16h-4M10 17l5-5-5-5M15 12H3",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
  check: "M5 12l5 5 9-10",
  x: "M6 6l12 12M18 6 6 18",
  copy: "M8 8h12v12H8zM4 16V4h12",
  save: "M5 3h11l3 3v15H5zM8 3v6h8V3M8 21v-7h8v7",
  rocket: "M5 15c-1.5 1.5-2 5-2 5s3.5-.5 5-2M9 15l-3-3c1-4 4-8 11-9 0 7-5 10-9 11l-3-3M15 9h.01",
};

export function Icon({ name, size = 18, title }: { name: keyof typeof P | string; size?: number; title?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden={title ? undefined : true} role={title ? "img" : undefined}>
      {title && <title>{title}</title>}
      <path d={P[name] ?? P.flow} />
    </svg>
  );
}

export const NODE_ICON: Record<NodeType, string> = {
  "trigger.webhook": "webhook",
  "trigger.schedule": "clock",
  "trigger.manual": "play",
  condition: "branch",
  http: "globe",
  "notify.discord": "chat",
  "notify.slack": "hash",
  "notify.telegram": "send",
};
