import jwt from "jsonwebtoken";
import type { CookieOptions, NextFunction, Request, Response } from "express";
import { envVar } from "../config/env.js";

/**
 * Sessão num cookie httpOnly: o JavaScript da página não lê, então um XSS não rouba o token.
 * Front e API no mesmo domínio: SameSite=Lax basta contra CSRF (o navegador não manda o cookie
 * em POST vindo de outro site). Path /api: o webhook público (/hooks) nunca recebe o cookie.
 */
export const SESSION_COOKIE = "motor_session";
/** Depois da senha certa, quem tem 2FA ganha só este cookie curto, que vale apenas para enviar o código. */
export const PENDING_COOKIE = "motor_2fa";

const SESSION_TTL = 7 * 24 * 60 * 60;
const PENDING_TTL = 5 * 60;

const cookieOptions = (maxAgeSeconds: number): CookieOptions => ({
  httpOnly: true,
  secure: envVar("NODE_ENV") === "production",
  sameSite: "lax",
  path: "/api",
  maxAge: maxAgeSeconds * 1000,
});

type Purpose = "session" | "2fa";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const sign = (userId: string, purpose: Purpose, ttl: number) =>
  jwt.sign({ sub: userId, purpose }, envVar("JWT_SECRET"), { expiresIn: ttl, algorithm: "HS256" });

export function readCookie(req: Request, name: string): string | null {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Usuário do token, se o token é válido e do propósito certo. */
export function tokenUser(req: Request, purpose: Purpose): string | null {
  const token = readCookie(req, purpose === "session" ? SESSION_COOKIE : PENDING_COOKIE);
  if (!token) return null;
  try {
    const p = jwt.verify(token, envVar("JWT_SECRET"), { algorithms: ["HS256"] }) as jwt.JwtPayload;
    return p.purpose === purpose && typeof p.sub === "string" && UUID.test(p.sub) ? p.sub : null;
  } catch {
    return null;
  }
}

export function startSession(res: Response, userId: string) {
  res.clearCookie(PENDING_COOKIE, { path: "/api" });
  res.cookie(SESSION_COOKIE, sign(userId, "session", SESSION_TTL), cookieOptions(SESSION_TTL));
}

export function endSession(res: Response) {
  res.clearCookie(SESSION_COOKIE, { path: "/api" });
  res.clearCookie(PENDING_COOKIE, { path: "/api" });
}

export const startPending2fa = (res: Response, userId: string) =>
  res.cookie(PENDING_COOKIE, sign(userId, "2fa", PENDING_TTL), cookieOptions(PENDING_TTL));

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const userId = tokenUser(req, "session");
  if (userId === null) return void res.status(401).json({ error: "Não autenticado" });
  res.locals.userId = userId;
  next();
}
