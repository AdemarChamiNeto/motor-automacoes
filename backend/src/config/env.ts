import { z } from "zod";

/** Chave de 32 bytes (AES-256) em hex ou base64. */
export function decodeKey(s: string): Buffer | null {
  if (/^[0-9a-fA-F]{64}$/.test(s)) return Buffer.from(s, "hex");
  if (!/^[A-Za-z0-9+/_-]{43}=?$/.test(s)) return null;
  const b = Buffer.from(s, "base64");
  return b.length === 32 ? b : null;
}

/** Variáveis obrigatórias: o servidor nem sobe se faltar alguma (`index.ts` chama `env()` antes de tudo). */
const schema = z.object({
  DATABASE_URL: z.string().min(1, "defina DATABASE_URL"),
  JWT_SECRET: z.string().min(32, "JWT_SECRET ausente ou curto (mínimo 32 caracteres)"),
  // uma chave só para o segredo do 2FA e para as credenciais das integrações
  ENCRYPTION_KEY: z
    .string({ error: (i) => (i.input === undefined ? "defina ENCRYPTION_KEY (gere com: openssl rand -hex 32)" : undefined) })
    .refine((s) => decodeKey(s) !== null, "ENCRYPTION_KEY deve ter 32 bytes: 64 caracteres hex (openssl rand -hex 32) ou base64 (o generateValue do Render)"),
  NODE_ENV: z.string().default("development"),
  /** Endereço público (URL dos webhooks, links de convite, canonical). No Render vem sozinho de RENDER_EXTERNAL_URL. */
  PUBLIC_URL: z.string().url().default(process.env.RENDER_EXTERNAL_URL ?? "http://localhost:3002"),
});

export type Env = z.infer<typeof schema>;

const fail = (issues: z.ZodIssue[]) => new Error("Configuração inválida: " + issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));

/** Valida tudo de uma vez (na subida do servidor). */
export function env(): Env {
  const r = schema.safeParse(process.env);
  if (!r.success) throw fail(r.error.issues);
  return r.data;
}

/** Lê e valida uma variável só (quem precisa só da chave não depende do resto). */
export function envVar<K extends keyof Env>(name: K): Env[K] {
  const r = schema.shape[name].safeParse(process.env[name]);
  if (!r.success) throw fail(r.error.issues.map((i) => ({ ...i, path: [name] })));
  return r.data as Env[K];
}
