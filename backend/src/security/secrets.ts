import crypto from "node:crypto";
import { decodeKey, envVar } from "../config/env.js";

/**
 * Segredos guardados no banco (segredo do 2FA e credenciais das integrações) com AES-256-GCM:
 * cifra + autenticação, então um valor adulterado no banco não decifra.
 * Formato salvo: "v1:<iv>:<tag>:<cifra>" em base64url.
 */
const key = () => decodeKey(envVar("ENCRYPTION_KEY"))!;

export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv, cipher.getAuthTag(), data].map((p) => (typeof p === "string" ? p : p.toString("base64url"))).join(":");
}

export function decrypt(stored: string): string {
  const [v, iv, tag, data] = stored.split(":");
  if (v !== "v1" || !iv || !tag || !data) throw new Error("Segredo em formato desconhecido");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
}

/** Token aleatório para URL (webhook, link de convite): 32 bytes → 43 caracteres base64url. */
export const randomToken = () => crypto.randomBytes(32).toString("base64url");

/**
 * Tokens aleatórios e longos são guardados com SHA-256: não precisam do custo do bcrypt
 * (que existe para senhas escolhidas por pessoas) e a busca pelo hash usa índice.
 */
export const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

/** Códigos de recuperação do 2FA: 10 códigos de 10 caracteres (≈ 50 bits cada), uso único. */
const RECOVERY_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"; // sem 0/o, 1/l/i

export function generateRecoveryCodes(n = 10): string[] {
  return Array.from({ length: n }, () => {
    const chars = Array.from({ length: 10 }, () => RECOVERY_ALPHABET[crypto.randomInt(RECOVERY_ALPHABET.length)]);
    return `${chars.slice(0, 5).join("")}-${chars.slice(5).join("")}`;
  });
}

export const normalizeRecoveryCode = (code: string) => code.toLowerCase().replace(/[^a-z0-9]/g, "");
export const hashRecoveryCode = (code: string) => sha256(normalizeRecoveryCode(code));
