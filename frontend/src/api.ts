/**
 * Cliente da API. A sessão é um cookie httpOnly (o JavaScript não vê o token); o navegador manda
 * sozinho porque front e API estão no mesmo domínio. Todo erro vira ApiError com a mensagem da API.
 */
export type Problem = { nodeId?: string; message: string };

export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly details?: unknown) {
    super(message);
    this.name = "ApiError";
  }
  /** Problemas do fluxo (422 da publicação) ou campos inválidos (400). */
  get problems(): Problem[] {
    return Array.isArray(this.details) ? (this.details as Problem[]) : [];
  }
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "Sem conexão com o servidor. Confira a internet e tente de novo.");
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let json: { error?: string; details?: unknown } | null = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // resposta que não é JSON (proxy, página de erro): não quebra, vira mensagem genérica
  }
  if (!res.ok) {
    const retry = res.headers.get("retry-after");
    const msg = json?.error ?? (res.status >= 500 ? "O servidor não respondeu como esperado. Tente de novo." : `Erro ${res.status}`);
    throw new ApiError(res.status, res.status === 429 && retry ? `${msg} (aguarde ${retry}s)` : msg, json?.details);
  }
  return json as T;
}

// ---------- tipos ----------
export type User = { id: string; name: string; email: string; twoFactorEnabled: boolean; demoExpiresAt: string | null };
export type Role = "viewer" | "editor" | "owner";
export type Workspace = { id: string; name: string; role: Role; members: number };
export type ExecStatus = "queued" | "running" | "succeeded" | "failed" | "canceled";

export type NodeType =
  | "trigger.webhook" | "trigger.schedule" | "trigger.manual"
  | "condition" | "http" | "ai" | "notify.discord" | "notify.slack" | "notify.telegram";
export type FlowNode = { id: string; type: NodeType; position: { x: number; y: number }; data: Record<string, unknown> };
export type FlowEdge = { id: string; source: string; target: string; sourceHandle?: "true" | "false" | null };
export type Definition = { nodes: FlowNode[]; edges: FlowEdge[] };

export type WorkflowSummary = {
  id: string; name: string; description: string; isActive: boolean; publishedVersion: number | null;
  triggerKind: "webhook" | "schedule" | null; lastStatus: ExecStatus | null; lastRunAt: string | null; updatedAt: string;
};
export type Workflow = {
  id: string; name: string; description: string; draft: Definition; isActive: boolean;
  publishedVersion: number | null; publishedAt: string | null; hasUnpublishedChanges: boolean;
  hasWebhook: boolean; nextRunAt: string | null; problems: Problem[];
};
export type ExecutionSummary = {
  id: string; status: ExecStatus; trigger: "webhook" | "schedule" | "manual"; attempt: number; error: string | null;
  version: number; createdAt: string; startedAt: string | null; finishedAt: string | null; runAt: string;
};
export type Step = {
  nodeId: string; nodeType: NodeType; attempt: number; status: "succeeded" | "failed" | "skipped";
  input: unknown; output: unknown; error: string | null; startedAt: string; finishedAt: string; durationMs: number;
};
export type Execution = ExecutionSummary & { input: unknown; definition: Definition; steps: Step[] };

export type CredentialKind = "discord_webhook" | "slack_webhook" | "telegram_bot" | "http_header" | "anthropic_key" | "gemini_key";
export type Credential = { id: string; kind: CredentialKind; name: string; createdBy: string | null; createdAt: string; updatedAt: string };
export type CredentialSecret =
  | { kind: "discord_webhook" | "slack_webhook"; url: string }
  | { kind: "telegram_bot"; token: string }
  | { kind: "http_header"; header: string; value: string }
  | { kind: "anthropic_key" | "gemini_key"; key: string };

export type Member = { id: string; name: string; email: string; role: Role; joinedAt: string };
export type Invite = { id: string; role: Role; email: string | null; kind: "link" | "email"; expiresAt: string };
export type ReceivedInvite = { id: string; role: Role; workspace: string; invitedBy: string | null; expiresAt: string };

const W = (ws: string) => `/workspaces/${ws}`;

export const api = {
  // auth
  me: () => req<User>("GET", "/auth/me"),
  login: (email: string, password: string) => req<{ user?: User; twoFactorRequired?: boolean }>("POST", "/auth/login", { email, password }),
  login2fa: (code: string) => req<{ user: User; recoveryCodesLeft: number }>("POST", "/auth/login/2fa", { code }),
  register: (name: string, email: string, password: string) => req<{ user: User }>("POST", "/auth/register", { name, email, password }),
  demo: () => req<{ user: User }>("POST", "/auth/demo"),
  logout: () => req<void>("POST", "/auth/logout"),
  setup2fa: () => req<{ secret: string; otpauthUrl: string }>("POST", "/auth/2fa/setup"),
  enable2fa: (code: string) => req<{ recoveryCodes: string[] }>("POST", "/auth/2fa/enable", { code }),
  disable2fa: (password: string, code: string) => req<void>("POST", "/auth/2fa/disable", { password, code }),

  // workspaces
  workspaces: () => req<Workspace[]>("GET", "/workspaces"),
  createWorkspace: (name: string) => req<{ id: string }>("POST", "/workspaces", { name }),
  renameWorkspace: (ws: string, name: string) => req<void>("PATCH", W(ws), { name }),
  deleteWorkspace: (ws: string) => req<void>("DELETE", W(ws)),
  members: (ws: string) => req<Member[]>("GET", `${W(ws)}/members`),
  setRole: (ws: string, userId: string, role: Role) => req<void>("PATCH", `${W(ws)}/members/${userId}`, { role }),
  removeMember: (ws: string, userId: string) => req<void>("DELETE", `${W(ws)}/members/${userId}`),
  invites: (ws: string) => req<Invite[]>("GET", `${W(ws)}/invites`),
  inviteLink: (ws: string, role: Role) => req<{ link: string; expiresAt: string }>("POST", `${W(ws)}/invites`, { role }),
  inviteEmail: (ws: string, role: Role, email: string) => req<{ message: string }>("POST", `${W(ws)}/invites`, { role, email }),
  revokeInvite: (ws: string, id: string) => req<void>("DELETE", `${W(ws)}/invites/${id}`),
  receivedInvites: () => req<ReceivedInvite[]>("GET", "/invites"),
  acceptInvite: (id: string) => req<{ workspaceId: string }>("POST", `/invites/${id}/accept`),
  acceptLink: (token: string) => req<{ workspaceId: string }>("POST", "/invites/accept-link", { token }),

  // credenciais
  credentials: (ws: string) => req<Credential[]>("GET", `${W(ws)}/credentials`),
  createCredential: (ws: string, name: string, secret: CredentialSecret) => req<Credential>("POST", `${W(ws)}/credentials`, { name, secret }),
  updateCredential: (ws: string, id: string, patch: { name?: string; secret?: CredentialSecret }) => req<Credential>("PATCH", `${W(ws)}/credentials/${id}`, patch),
  deleteCredential: (ws: string, id: string) => req<void>("DELETE", `${W(ws)}/credentials/${id}`),

  // fluxos
  workflows: (ws: string) => req<WorkflowSummary[]>("GET", `${W(ws)}/workflows`),
  workflow: (ws: string, id: string) => req<Workflow>("GET", `${W(ws)}/workflows/${id}`),
  createWorkflow: (ws: string, name: string) => req<{ id: string }>("POST", `${W(ws)}/workflows`, { name }),
  saveWorkflow: (ws: string, id: string, patch: { name?: string; description?: string; draft?: Definition }) =>
    req<{ problems: Problem[] }>("PATCH", `${W(ws)}/workflows/${id}`, patch),
  deleteWorkflow: (ws: string, id: string) => req<void>("DELETE", `${W(ws)}/workflows/${id}`),
  publish: (ws: string, id: string) => req<{ version: number; webhookUrl: string | null }>("POST", `${W(ws)}/workflows/${id}/publish`),
  setActive: (ws: string, id: string, active: boolean) => req<void>("POST", `${W(ws)}/workflows/${id}/${active ? "activate" : "deactivate"}`),
  rotateWebhook: (ws: string, id: string) => req<{ webhookUrl: string }>("POST", `${W(ws)}/workflows/${id}/webhook/rotate`),
  run: (ws: string, id: string, input: Record<string, unknown>) => req<{ executionId: string }>("POST", `${W(ws)}/workflows/${id}/run`, { input }),

  // execuções
  executions: (ws: string, id: string, opts: { status?: ExecStatus; cursor?: string | null } = {}) => {
    const q = new URLSearchParams();
    if (opts.status) q.set("status", opts.status);
    if (opts.cursor) q.set("cursor", opts.cursor);
    return req<{ items: ExecutionSummary[]; nextCursor: string | null }>("GET", `${W(ws)}/workflows/${id}/executions?${q}`);
  },
  execution: (ws: string, id: string, execId: string) => req<Execution>("GET", `${W(ws)}/workflows/${id}/executions/${execId}`),
  cancel: (ws: string, id: string, execId: string) => req<void>("POST", `${W(ws)}/workflows/${id}/executions/${execId}/cancel`),
};
