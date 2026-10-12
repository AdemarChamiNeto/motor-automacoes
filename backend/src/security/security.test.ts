import test from "node:test";
import assert from "node:assert/strict";
import { base32Decode, base32Encode, codeForStep, generateSecret, otpauthUrl, stepAt, verifyCode } from "./totp.js";
import { decodeKey } from "../config/env.js";

process.env.ENCRYPTION_KEY ??= "0".repeat(64);
const { decrypt, encrypt, generateRecoveryCodes, hashRecoveryCode, randomToken, sha256 } = await import("./secrets.js");

// Segredo dos vetores de teste da RFC 6238 (SHA-1): "12345678901234567890" em ASCII
const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890"));

test("TOTP: vetores oficiais da RFC 6238 (8 dígitos)", () => {
  for (const [seconds, expected] of [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
  ] as const) {
    assert.equal(codeForStep(RFC_SECRET, stepAt(new Date(seconds * 1000)), 8), expected);
  }
});

test("TOTP: base32 vai e volta; 1 passo de tolerância; código usado não vale de novo", () => {
  const secret = generateSecret();
  assert.match(secret, /^[A-Z2-7]{32}$/);
  assert.equal(base32Encode(base32Decode(secret)), secret);
  const now = new Date("2026-10-12T12:00:00Z");
  const step = stepAt(now);
  assert.equal(verifyCode(RFC_SECRET, codeForStep(RFC_SECRET, step - 1), now), step - 1);
  assert.equal(verifyCode(RFC_SECRET, codeForStep(RFC_SECRET, step - 2), now), null);
  assert.equal(verifyCode(RFC_SECRET, codeForStep(RFC_SECRET, step), now, step), null);
  assert.equal(verifyCode(RFC_SECRET, "abcdef", now), null);
  assert.equal(new URL(otpauthUrl("JBSWY3DPEHPK3PXP", "ana@exemplo.com")).searchParams.get("issuer"), "Motor de Automações");
});

test("segredo criptografado: vai e volta, IV diferente a cada vez e recusa valor adulterado", () => {
  const a = encrypt("https://discord.com/api/webhooks/1/abc");
  assert.notEqual(a, encrypt("https://discord.com/api/webhooks/1/abc"));
  assert.ok(!a.includes("discord"));
  assert.equal(decrypt(a), "https://discord.com/api/webhooks/1/abc");
  const [v, iv, tag, data] = a.split(":");
  const flipped = (data[0] === "A" ? "B" : "A") + data.slice(1);
  assert.throws(() => decrypt([v, iv, tag, flipped].join(":")));
});

test("tokens e códigos de recuperação", () => {
  assert.match(randomToken(), /^[A-Za-z0-9_-]{43}$/);
  assert.match(sha256("x"), /^[0-9a-f]{64}$/);
  const codes = generateRecoveryCodes();
  assert.equal(new Set(codes).size, 10);
  assert.equal(hashRecoveryCode(codes[0]), hashRecoveryCode(codes[0].toUpperCase().replace("-", " ")));
});

test("chave de criptografia: aceita 32 bytes em hex ou base64 (generateValue do Render), recusa o resto", () => {
  const bytes = Buffer.alloc(32, 7);
  assert.deepEqual(decodeKey(bytes.toString("hex")), bytes);
  assert.deepEqual(decodeKey(bytes.toString("base64")), bytes);
  assert.equal(decodeKey("curta"), null);
  assert.equal(decodeKey(Buffer.alloc(31).toString("base64")), null);
});
