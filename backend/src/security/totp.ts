import crypto from "node:crypto";

/**
 * TOTP (RFC 6238) com HMAC-SHA1, 6 dígitos e passo de 30 s — o padrão que Google Authenticator,
 * Authy e Microsoft Authenticator entendem. Feito com o `crypto` do Node, sem dependência.
 */
const STEP_SECONDS = 30;
const DIGITS = 6;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/=+$/, "").replace(/\s/g, "");
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error("Segredo base32 inválido");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Segredo novo de 160 bits (o tamanho que a RFC recomenda para SHA-1), em base32. */
export const generateSecret = () => base32Encode(crypto.randomBytes(20));

export const stepAt = (time: Date) => Math.floor(time.getTime() / 1000 / STEP_SECONDS);

/** Código do passo `step` (HOTP da RFC 4226 com o contador = passo de tempo). */
export function codeForStep(secret: string, step: number, digits = DIGITS): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = crypto.createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const bin = (hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return String(bin).padStart(digits, "0");
}

/**
 * Confere o código aceitando 1 passo antes/depois (relógio do celular adiantado/atrasado).
 * Devolve o passo usado — quem chama guarda e recusa passo igual ou anterior (código não pode ser reusado).
 */
export function verifyCode(secret: string, code: string, now: Date, lastUsedStep: number | null = null): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const current = stepAt(now);
  for (const step of [current - 1, current, current + 1]) {
    if (lastUsedStep !== null && step <= lastUsedStep) continue;
    const expected = codeForStep(secret, step);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(code))) return step;
  }
  return null;
}

/** URL que vira o QR code lido pelo app autenticador. */
export function otpauthUrl(secret: string, account: string, issuer = "Motor de Automações"): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret, issuer, algorithm: "SHA1", digits: String(DIGITS), period: String(STEP_SECONDS) });
  return `otpauth://totp/${label}?${params}`;
}
