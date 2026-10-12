import type { Request } from "express";
import { ipKeyGenerator, rateLimit, type Options } from "express-rate-limit";
import { tokenUser } from "./session.js";

/**
 * Rate limit em todos os endpoints (padrão do projeto). Resposta 429 com Retry-After.
 * Contador em memória: o Render free roda uma instância só. Com mais de uma, trocar o `store`
 * por um compartilhado (o banco ou Redis).
 */
const MIN = 60_000;
const n = (name: string, fallback: number) => Number(process.env[name] ?? fallback);

const ip = (req: Request) => `ip:${ipKeyGenerator(req.ip ?? "")}`;
/** Usuário da sessão (ou do login pendente de 2FA), validado; sem sessão, cai no IP. */
const userOrIp = (req: Request) => {
  const id = tokenUser(req, "session") ?? tokenUser(req, "2fa");
  return id ? `user:${id}` : ip(req);
};

const make = (limit: number, windowMs: number, extra: Partial<Options> = {}) =>
  rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    keyGenerator: ip,
    message: { error: "Muitas requisições. Tente de novo em alguns minutos." },
    ...extra,
  });

export function createLimits() {
  const auth = n("AUTH_RATE_LIMIT", 5);
  return {
    /** Erros de login por IP (login certo não conta). */
    loginIp: make(auth, 15 * MIN, { skipSuccessfulRequests: true }),
    /** Erros de login por conta: trava força bruta numa conta mesmo vinda de vários IPs. */
    loginAccount: make(auth, 15 * MIN, {
      skipSuccessfulRequests: true,
      keyGenerator: (req) => `email:${String(req.body?.email ?? "").trim().toLowerCase().slice(0, 254)}`,
    }),
    register: make(auth, 15 * MIN),
    /** Conta de demonstração: cada uma cria linhas no banco, então poucas por IP. */
    demo: make(n("DEMO_RATE_LIMIT", 5), 60 * MIN),
    /** Códigos de 2FA e aceitar convite: por usuário (inclusive o login pendente). */
    twoFactor: make(auth, 15 * MIN, { skipSuccessfulRequests: true, keyGenerator: userOrIp }),
    /** Escrita (POST/PUT/PATCH/DELETE): 30/min por usuário. */
    write: make(n("WRITE_RATE_LIMIT", 30), MIN, {
      keyGenerator: userOrIp,
      skip: (req) => req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS",
    }),
    /** Leitura: 120/min por usuário ou IP. */
    read: make(n("READ_RATE_LIMIT", 120), MIN, {
      keyGenerator: userOrIp,
      skip: (req) => req.method !== "GET" && req.method !== "HEAD",
    }),
    /** Webhook público: por token (um fluxo não afoga o motor) e por IP (ninguém varre tokens). */
    hookToken: make(n("HOOK_RATE_LIMIT", 60), MIN, { keyGenerator: (req) => `hook:${String(req.params.token).slice(0, 64)}` }),
    hookIp: make(n("HOOK_IP_RATE_LIMIT", 120), MIN),
  };
}

export type Limits = ReturnType<typeof createLimits>;
