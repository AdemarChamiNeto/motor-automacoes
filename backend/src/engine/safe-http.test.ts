import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { HttpFailure, checkUrl, isBlockedAddress, safeHttp } from "./safe-http.js";

test("bloqueia endereços internos e reservados, IPv4 e IPv6", () => {
  for (const ip of [
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.0.10", "169.254.169.254", // metadados da nuvem
    "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255",
    "::1", "::", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "64:ff9b::7f00:1", "2002:7f00:1::",
    "não é ip",
  ]) assert.equal(isBlockedAddress(ip), true, ip);
  for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700:4700::1111"]) assert.equal(isBlockedAddress(ip), false, ip);
});

test("URL: só http(s), sem credencial embutida, portas comuns e IP interno escrito direto é barrado", () => {
  const blocked = (url: string) => assert.throws(() => checkUrl(url), (e) => e instanceof HttpFailure && e.kind === "blocked", url);
  blocked("file:///etc/passwd");
  blocked("ftp://exemplo.com/");
  blocked("http://usuario:senha@exemplo.com/");
  blocked("http://exemplo.com:22/");
  blocked("http://127.0.0.1/");
  blocked("http://[::1]/");
  blocked("http://169.254.169.254/latest/meta-data/");
  assert.throws(() => checkUrl("não é url"), (e) => e instanceof HttpFailure && e.kind === "invalid");
  assert.equal(checkUrl("https://api.exemplo.com:8443/x?y=1").hostname, "api.exemplo.com");
});

test("nome que resolve para rede interna é barrado na conexão (DNS conferido pelo lookup)", async () => {
  // servidor local de verdade: sem a proteção, a chamada funcionaria
  const server = http.createServer((_req, res) => res.end("segredo interno"));
  await new Promise<void>((r) => server.listen(8080, "127.0.0.1", r));
  try {
    await assert.rejects(safeHttp({ method: "GET", url: "http://localhost:8080/", timeoutMs: 2000 }),
      (e) => e instanceof HttpFailure && e.kind === "blocked");
    await assert.rejects(safeHttp({ method: "GET", url: "http://127.0.0.1:8080/", timeoutMs: 2000 }),
      (e) => e instanceof HttpFailure && e.kind === "blocked");
  } finally {
    server.close();
  }
});

test("porta fora da lista nem tenta conectar", async () => {
  const server = http.createServer((_req, res) => res.end("ok"));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    await assert.rejects(safeHttp({ method: "GET", url: `http://localhost:${port}/`, timeoutMs: 2000 }), HttpFailure);
  } finally {
    server.close();
  }
});
