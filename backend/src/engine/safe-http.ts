import dns from "node:dns";
import net from "node:net";
import { Agent, fetch } from "undici";

/**
 * Cliente HTTP dos nós do fluxo, com proteção contra SSRF.
 *
 * O risco: quem monta o fluxo escolhe a URL, e a chamada sai do NOSSO servidor. Sem proteção,
 * daria para ler serviços internos (banco, painel de admin, 169.254.169.254 com as credenciais da
 * nuvem). Por isso:
 *  - só http/https, sem usuário:senha na URL e só portas comuns;
 *  - o IP é conferido DEPOIS de resolver o DNS, dentro da própria conexão (lookup do Agent):
 *    um domínio que resolve para 127.0.0.1, ou que troca de IP entre a checagem e a conexão
 *    (DNS rebinding), é barrado;
 *  - redirecionamentos são seguidos à mão (no máximo 3), conferindo cada destino;
 *  - timeout e teto de tamanho da resposta.
 */

// duas listas: o BlockList compara IPv4 também com regras IPv6 (e ::ffff:0:0/96 pegaria todo IPv4)
const blockedV4 = new net.BlockList();
const blockedV6 = new net.BlockList();
for (const [addr, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blockedV4.addSubnet(addr, prefix, "ipv4");
for (const [addr, prefix] of [
  ["::", 128], ["::1", 128], ["::ffff:0:0", 96], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64],
  ["2001::", 32], ["2001:db8::", 32], ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) blockedV6.addSubnet(addr, prefix, "ipv6");

/** true se o IP não é endereço público da internet (privado, loopback, link-local, reservado...). */
export function isBlockedAddress(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 0) return true;
  if (family === 6) {
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip); // ::ffff:127.0.0.1
    if (mapped) return isBlockedAddress(mapped[1]);
    return blockedV6.check(ip, "ipv6");
  }
  return blockedV4.check(ip, "ipv4");
}

export const ALLOWED_PORTS = new Set(["", "80", "443", "8080", "8443"]);

export type HttpErrorKind = "blocked" | "timeout" | "network" | "too_large" | "invalid";

/** Falha antes de existir resposta HTTP. `kind` define se vale tentar de novo. */
export class HttpFailure extends Error {
  constructor(message: string, readonly kind: HttpErrorKind) {
    super(message);
    this.name = "HttpFailure";
  }
}

/** Confere a URL antes de conectar. Lança HttpFailure("blocked"/"invalid"). */
export function checkUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpFailure("URL inválida", "invalid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new HttpFailure("só http e https são permitidos", "blocked");
  if (url.username || url.password) throw new HttpFailure("URL com usuário/senha não é permitida (use uma credencial)", "blocked");
  if (!ALLOWED_PORTS.has(url.port)) throw new HttpFailure(`porta ${url.port} não permitida (use 80, 443, 8080 ou 8443)`, "blocked");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  // IP escrito direto na URL não passa pelo DNS, então é conferido aqui
  if (net.isIP(host) && isBlockedAddress(host)) throw new HttpFailure("endereço de rede interna bloqueado", "blocked");
  return url;
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;

/** DNS com filtro: se QUALQUER IP do nome for interno, a conexão nem começa. */
export function safeLookup(hostname: string, options: dns.LookupOptions, callback: LookupCallback) {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, "");
    const list = addresses as dns.LookupAddress[];
    if (list.length === 0 || list.some((a) => isBlockedAddress(a.address))) {
      const e = new HttpFailure(`${hostname} aponta para rede interna: bloqueado`, "blocked") as unknown as NodeJS.ErrnoException;
      return callback(e, "");
    }
    if (options.all) return callback(null, list);
    callback(null, list[0].address, list[0].family);
  });
}

export type HttpRequest = {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs: number;
};

export type HttpResponse = {
  status: number;
  headers: Record<string, string>;
  /** JSON já convertido quando o content-type é JSON; senão, texto. */
  body: unknown;
};

export type HttpClient = (req: HttpRequest) => Promise<HttpResponse>;

export const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_REDIRECTS = 3;
const KEPT_HEADERS = ["content-type", "retry-after", "location", "x-request-id"];

let agent: Agent | null = null;
const getAgent = () => (agent ??= new Agent({ connect: { lookup: safeLookup as never, timeout: 5_000 } }));

async function readCapped(res: Response | Awaited<ReturnType<typeof fetch>>, max: number): Promise<string> {
  if (!res.body) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
    size += chunk.byteLength;
    if (size > max) throw new HttpFailure(`resposta maior que ${Math.round(max / 1000)} KB`, "too_large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Cliente de produção: valida a URL, conecta só em IP público, segue redirecionamento conferindo cada um. */
export const safeHttp: HttpClient = async (req) => {
  const signal = AbortSignal.timeout(req.timeoutMs);
  let url = checkUrl(req.url);
  let method = req.method;
  let body = req.body;
  try {
    for (let hop = 0; ; hop++) {
      const res = await fetch(url, {
        method,
        headers: { "user-agent": "motor-automacoes/1.0", ...req.headers },
        body: method === "GET" || method === "HEAD" ? undefined : body,
        redirect: "manual",
        signal,
        dispatcher: getAgent(),
      });
      if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.get("location")) {
        await res.body?.cancel();
        if (hop >= MAX_REDIRECTS) throw new HttpFailure("redirecionamentos demais", "invalid");
        url = checkUrl(new URL(res.headers.get("location")!, url).toString());
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
          method = "GET";
          body = undefined;
        }
        continue;
      }
      const text = await readCapped(res, MAX_RESPONSE_BYTES);
      const headers: Record<string, string> = {};
      for (const h of KEPT_HEADERS) {
        const v = res.headers.get(h);
        if (v) headers[h] = v;
      }
      let parsed: unknown = text;
      if ((headers["content-type"] ?? "").includes("json") && text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          // diz que é JSON mas não é (ex.: página de erro de proxy em HTML): fica como texto
        }
      }
      return { status: res.status, headers, body: parsed };
    }
  } catch (err) {
    if (err instanceof HttpFailure) throw err;
    const cause = (err as { cause?: unknown }).cause;
    if (cause instanceof HttpFailure) throw cause;
    if (signal.aborted || (err as Error).name === "TimeoutError") throw new HttpFailure(`sem resposta em ${req.timeoutMs} ms`, "timeout");
    const code = (cause as { code?: string } | undefined)?.code;
    throw new HttpFailure(`falha de rede${code ? ` (${code})` : ""}`, "network");
  }
};
