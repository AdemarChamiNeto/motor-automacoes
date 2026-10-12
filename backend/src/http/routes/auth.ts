import crypto from "node:crypto";
import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { asSystem, type Db } from "../../db/pool.js";
import { decrypt, encrypt, generateRecoveryCodes, hashRecoveryCode } from "../../security/secrets.js";
import { generateSecret, otpauthUrl, verifyCode } from "../../security/totp.js";
import { createWorkspaceWithOwner } from "../../services/workspaces.js";
import { HttpError, parse } from "../errors.js";
import type { Limits } from "../limits.js";
import { endSession, requireAuth, startPending2fa, startSession, tokenUser } from "../session.js";

/** Custo do bcrypt (padrão do projeto: ≥ 12). Hashes antigos com custo menor são refeitos no login. */
export const BCRYPT_COST = 12;
// usado quando o e-mail não existe, para o tempo de resposta não revelar quais e-mails têm conta
const DUMMY_HASH = bcrypt.hashSync("senha-que-ninguem-usa", BCRYPT_COST);
/** Conta de "experimentar sem cadastro" dura 24 h. */
export const DEMO_TTL_HOURS = 24;

const email = z.string().trim().toLowerCase().email("e-mail inválido").max(254);
const password = z.string().min(8, "a senha precisa de pelo menos 8 caracteres").max(200);
const codeSchema = z.object({ code: z.string().trim().min(6).max(20) });

type UserRow = { id: string; name: string; email: string; demo_expires_at: Date | null; two_factor_enabled: boolean };
const pub = (u: UserRow) => ({
  id: u.id, name: u.name, email: u.email, twoFactorEnabled: u.two_factor_enabled, demoExpiresAt: u.demo_expires_at,
});

async function findUser(c: Db, id: string): Promise<UserRow | undefined> {
  return (await c.query<UserRow>(
    `SELECT u.id, u.name, u.email, u.demo_expires_at,
            EXISTS (SELECT 1 FROM user_totp t WHERE t.user_id = u.id AND t.enabled_at IS NOT NULL) AS two_factor_enabled
       FROM users u WHERE u.id = $1 AND u.deleted_at IS NULL`,
    [id],
  )).rows[0];
}

/** Confere o segundo fator: código do app (não reutilizável) ou código de recuperação (uso único). */
async function checkSecondFactor(c: Db, userId: string, code: string): Promise<boolean> {
  const t = (await c.query<{ secret_encrypted: string; last_used_step: string | null }>(
    "SELECT secret_encrypted, last_used_step FROM user_totp WHERE user_id = $1 AND enabled_at IS NOT NULL",
    [userId],
  )).rows[0];
  if (!t) return false;
  if (/^\d{6}$/.test(code)) {
    const lastUsed = t.last_used_step === null ? null : Number(t.last_used_step);
    const step = verifyCode(decrypt(t.secret_encrypted), code, new Date(), lastUsed);
    if (step === null) return false;
    // só grava se ninguém usou um passo igual ou maior no meio tempo (duas requisições ao mesmo tempo)
    const r = await c.query(
      "UPDATE user_totp SET last_used_step = $1 WHERE user_id = $2 AND (last_used_step IS NULL OR last_used_step < $1)",
      [step, userId],
    );
    return r.rowCount === 1;
  }
  const r = await c.query(
    "UPDATE recovery_codes SET used_at = now() WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL",
    [userId, hashRecoveryCode(code)],
  );
  return r.rowCount === 1;
}

const firstName = (name: string) => name.trim().split(/\s+/)[0];

async function createAccount(c: Db, name: string, mail: string, hash: string, demoHours?: number): Promise<string> {
  const { rows: [u] } = await c.query<{ id: string }>(
    `INSERT INTO users (name, email, demo_expires_at) VALUES ($1, $2, CASE WHEN $3::int IS NULL THEN NULL ELSE now() + $3 * interval '1 hour' END) RETURNING id`,
    [name.trim(), mail, demoHours ?? null],
  );
  await c.query("INSERT INTO user_passwords (user_id, password_hash) VALUES ($1, $2)", [u.id, hash]);
  await createWorkspaceWithOwner(c, u.id, `Workspace de ${firstName(name)}`, true);
  return u.id;
}

export function authRouter(l: Limits) {
  const r = Router();

  r.post("/register", l.register, async (req, res) => {
    const p = parse(z.object({ name: z.string().trim().min(2).max(100), email, password }), req.body);
    const hash = await bcrypt.hash(p.password, BCRYPT_COST);
    const user = await asSystem(async (c) => findUser(c, await createAccount(c, p.name, p.email, hash)));
    startSession(res, user!.id);
    res.status(201).json({ user: pub(user!) });
  });

  /**
   * "Experimentar sem cadastro": conta temporária com e-mail e senha aleatórios, que some em 24 h
   * junto com o workspace. Ninguém precisa digitar dados pessoais para ver a demo.
   */
  r.post("/demo", l.demo, async (_req, res) => {
    const suffix = crypto.randomBytes(6).toString("hex");
    const hash = await bcrypt.hash(crypto.randomBytes(24).toString("base64url"), BCRYPT_COST);
    const user = await asSystem(async (c) => findUser(c, await createAccount(c, "Visitante", `visitante-${suffix}@demo.invalid`, hash, DEMO_TTL_HOURS)));
    startSession(res, user!.id);
    res.status(201).json({ user: pub(user!) });
  });

  r.post("/login", l.loginIp, l.loginAccount, async (req, res) => {
    const p = z.object({ email, password: z.string().min(1).max(200) }).safeParse(req.body);
    const fail = () => res.status(401).json({ error: "E-mail ou senha incorretos" });
    if (!p.success) return void fail();
    const result = await asSystem(async (c) => {
      const u = (await c.query<{ id: string; password_hash: string }>(
        `SELECT u.id, p.password_hash FROM users u JOIN user_passwords p ON p.user_id = u.id
          WHERE u.email = $1 AND u.deleted_at IS NULL`,
        [p.data.email],
      )).rows[0];
      const ok = await bcrypt.compare(p.data.password, u?.password_hash ?? DUMMY_HASH);
      if (!u || !ok) return null;
      if (bcrypt.getRounds(u.password_hash) < BCRYPT_COST) {
        await c.query("UPDATE user_passwords SET password_hash = $1 WHERE user_id = $2", [await bcrypt.hash(p.data.password, BCRYPT_COST), u.id]);
      }
      return findUser(c, u.id);
    });
    if (!result) return void fail();
    if (result.two_factor_enabled) {
      startPending2fa(res, result.id);
      return void res.json({ twoFactorRequired: true });
    }
    startSession(res, result.id);
    res.json({ user: pub(result) });
  });

  r.post("/login/2fa", l.twoFactor, async (req, res) => {
    const userId = tokenUser(req, "2fa");
    if (userId === null) throw new HttpError(401, "Faça o login de novo");
    const p = codeSchema.safeParse(req.body);
    const result = await asSystem(async (c) => {
      if (!p.success || !(await checkSecondFactor(c, userId, p.data.code))) return null;
      const left = (await c.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM recovery_codes WHERE user_id = $1 AND used_at IS NULL", [userId],
      )).rows[0].n;
      return { user: await findUser(c, userId), left };
    });
    if (!result?.user) throw new HttpError(401, "Código inválido");
    startSession(res, userId);
    res.json({ user: pub(result.user), recoveryCodesLeft: result.left });
  });

  r.post("/logout", (_req, res) => {
    endSession(res);
    res.status(204).end();
  });

  r.get("/me", requireAuth, async (_req, res) => {
    const u = await asSystem((c) => findUser(c, res.locals.userId));
    if (!u) {
      endSession(res);
      throw new HttpError(401, "Sessão inválida");
    }
    res.json(pub(u));
  });

  // ===== 2FA opcional (tela "Minha conta") =====

  /** Passo 1: gera o segredo e a URL do QR code. Só passa a valer depois de confirmado com um código. */
  r.post("/2fa/setup", requireAuth, l.twoFactor, async (_req, res) => {
    const out = await asSystem(async (c) => {
      const user = await findUser(c, res.locals.userId);
      if (!user) throw new HttpError(401, "Sessão inválida");
      if (user.two_factor_enabled) throw new HttpError(409, "O 2FA já está ativo");
      const secret = generateSecret();
      await c.query(
        `INSERT INTO user_totp (user_id, secret_encrypted) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET secret_encrypted = EXCLUDED.secret_encrypted, last_used_step = NULL`,
        [user.id, encrypt(secret)],
      );
      return { secret, otpauthUrl: otpauthUrl(secret, user.email) };
    });
    res.json(out);
  });

  /** Passo 2: confirma com o primeiro código, ativa e devolve os códigos de recuperação (mostrados uma vez). */
  r.post("/2fa/enable", requireAuth, l.twoFactor, async (req, res) => {
    const p = codeSchema.safeParse(req.body);
    const codes = generateRecoveryCodes();
    await asSystem(async (c) => {
      const t = (await c.query<{ secret_encrypted: string; enabled_at: Date | null }>(
        "SELECT secret_encrypted, enabled_at FROM user_totp WHERE user_id = $1 FOR UPDATE", [res.locals.userId],
      )).rows[0];
      if (!t) throw new HttpError(400, "Gere o QR code primeiro");
      if (t.enabled_at) throw new HttpError(409, "O 2FA já está ativo");
      const step = p.success ? verifyCode(decrypt(t.secret_encrypted), p.data.code, new Date()) : null;
      if (step === null) throw new HttpError(400, "Código inválido. Confira o horário do celular e tente de novo.");
      await c.query("UPDATE user_totp SET enabled_at = now(), last_used_step = $1 WHERE user_id = $2", [step, res.locals.userId]);
      await c.query("DELETE FROM recovery_codes WHERE user_id = $1", [res.locals.userId]);
      await c.query("INSERT INTO recovery_codes (user_id, code_hash) SELECT $1, unnest($2::text[])", [res.locals.userId, codes.map(hashRecoveryCode)]);
    });
    res.json({ recoveryCodes: codes });
  });

  /** Desativar pede senha e código: quem pegou só a sessão não consegue. */
  r.post("/2fa/disable", requireAuth, l.twoFactor, async (req, res) => {
    const p = parse(z.object({ password: z.string().min(1).max(200), code: z.string().trim().min(6).max(20) }), req.body);
    await asSystem(async (c) => {
      const u = (await c.query<{ password_hash: string }>("SELECT password_hash FROM user_passwords WHERE user_id = $1", [res.locals.userId])).rows[0];
      const ok = await bcrypt.compare(p.password, u?.password_hash ?? DUMMY_HASH);
      if (!u || !ok || !(await checkSecondFactor(c, res.locals.userId, p.code))) throw new HttpError(401, "Senha ou código incorretos");
      await c.query("DELETE FROM user_totp WHERE user_id = $1", [res.locals.userId]);
      await c.query("DELETE FROM recovery_codes WHERE user_id = $1", [res.locals.userId]);
    });
    res.status(204).end();
  });

  return r;
}
