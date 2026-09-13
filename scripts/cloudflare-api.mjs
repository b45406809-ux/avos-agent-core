import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Agent } from "undici";

const base = "https://api.cloudflare.com/client/v4";
const NETWORK_CODES = new Set(["ENETUNREACH", "EHOSTUNREACH", "ENETDOWN", "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND"]);
const RETRY_STATUS = new Set([429, 500, 502, 503, 504, 522, 523, 524]);
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const SECRET_PATTERN = /(api[_-]?token|client[_-]?secret|private[_-]?key|session[_-]?hmac|credential[_-]?kek)(["'\s:=]+)([^\s,"']+)/gi;

export function sanitize(value) {
  return String(value ?? "")
    .replace(/(authorization["'\s:=]+bearer\s+)([^\s,"']+)/gi, "$1[REDACTED]")
    .replace(/(bearer\s+)([^\s,"']+)/gi, "$1[REDACTED]")
    .replace(SECRET_PATTERN, "$1$2[REDACTED]");
}

function networkCode(error) {
  let current = error;
  while (current) {
    if (current.code) return current.code;
    current = current.cause;
  }
  return error?.name === "TimeoutError" || error?.name === "AbortError" ? "ETIMEDOUT" : undefined;
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function retryDelay(attempt, response, random) {
  const retryAfter = response?.headers?.get?.("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.min(seconds * 1000, 30_000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.min(Math.max(0, date - Date.now()), 30_000);
  }
  return Math.min(250 * (2 ** (attempt - 1)), 4_000) * (0.5 + random());
}

export class CloudflareRequestError extends Error {
  constructor(message, details = {}) {
    super(sanitize(message));
    this.name = "CloudflareRequestError";
    Object.assign(this, details);
  }
}

function curlRequest(url, init, { spawnImpl = spawn, timeoutMs = 15_000 } = {}) {
  return new Promise(async (resolve, reject) => {
    const directory = await mkdtemp(path.join(tmpdir(), "avos-cf-"));
    const headerFile = path.join(directory, "headers");
    const outputFile = path.join(directory, "response");
    const headers = Object.entries(init.headers || {});
    await writeFile(headerFile, headers.map(([name, value]) => `${name}: ${value}\n`).join(""), { mode: 0o600 });
    const args = ["--silent", "--show-error", "--location", "--max-time", String(Math.ceil(timeoutMs / 1000)), "--request", init.method, "--header", `@${headerFile}`, "--output", outputFile, "--write-out", "%{http_code}"];
    if (init.body != null) args.push("--data-binary", "@-");
    args.push(url);
    const child = spawnImpl("curl", args, { stdio: ["pipe", "pipe", "pipe"] });
    const stdout = [], stderr = [];
    child.stdout.on("data", chunk => stdout.push(chunk));
    child.stderr.on("data", chunk => stderr.push(chunk));
    child.on("error", async error => { await rm(directory, { recursive: true, force: true }); reject(error); });
    child.on("close", async code => {
      try {
        if (code !== 0) throw Object.assign(new Error(`curl transport failed (${code}): ${sanitize(Buffer.concat(stderr).toString())}`), { code: code === 28 ? "ETIMEDOUT" : "ECURL" });
        const body = await import("node:fs/promises").then(fs => fs.readFile(outputFile));
        resolve(new Response(body, { status: Number(Buffer.concat(stdout).toString()) }));
      } catch (error) { reject(error); }
      finally { await rm(directory, { recursive: true, force: true }); }
    });
    if (init.body != null) child.stdin.end(init.body instanceof Uint8Array ? init.body : String(init.body));
    else child.stdin.end();
  });
}

/** One bounded, retrying transport shared by JSON and raw API calls. */
export function createTransport(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = options.timeoutMs || 15_000;
  const maxAttempts = options.maxAttempts || 4;
  const random = options.random || Math.random;
  const sleepImpl = options.sleepImpl || sleep;
  const dispatcher = options.dispatcher || new Agent({ connect: { autoSelectFamily: true, autoSelectFamilyAttemptTimeout: 250 } });
  return async function transport(url, request = {}) {
    const method = (request.method || "GET").toUpperCase();
    const operation = request.operation || `${method} ${new URL(url).pathname}`;
    const safeToRepeat = SAFE_METHODS.has(method) || request.idempotent === true;
    const allowCurl = request.curlFallback !== false;
    const init = { ...request, method, signal: undefined };
    delete init.operation; delete init.idempotent; delete init.curlFallback;
    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const transports = attempt === 1 ? [["native-auto", dispatcher]] : [["native-ipv4", new Agent({ connect: { family: 4 } })]];
      for (const [selected, activeDispatcher] of transports) {
        try {
          const response = await fetchImpl(url, { ...init, dispatcher: activeDispatcher, signal: AbortSignal.timeout(timeoutMs) });
          Object.defineProperty(response, "avosTransport", { value: selected, configurable: true });
          Object.defineProperty(response, "avosAttempt", { value: attempt, configurable: true });
          if (!RETRY_STATUS.has(response.status) || !safeToRepeat || attempt === maxAttempts) return response;
          await sleepImpl(retryDelay(attempt, response, random));
          break;
        } catch (error) {
          const code = networkCode(error);
          const mayHaveReached = !SAFE_METHODS.has(method) && !["ENETUNREACH", "EHOSTUNREACH", "ENETDOWN", "ENOTFOUND", "EAI_AGAIN"].includes(code);
          lastError = new CloudflareRequestError(`${operation} failed via ${selected}: network error ${code || "UNKNOWN"}`, { operation, endpoint: new URL(url).pathname, method, attempt, transport: selected, networkCode: code, mayHaveReached, reconciliationAttempted: false });
          if (!NETWORK_CODES.has(code) || !safeToRepeat || attempt === maxAttempts) break;
        }
      }
      if (attempt === maxAttempts && lastError && allowCurl && NETWORK_CODES.has(lastError.networkCode) && (safeToRepeat || !lastError.mayHaveReached)) {
        try {
          const response = await (options.curlImpl || curlRequest)(url, init, { spawnImpl: options.spawnImpl, timeoutMs });
          Object.defineProperty(response, "avosTransport", { value: "curl", configurable: true });
          Object.defineProperty(response, "avosAttempt", { value: attempt, configurable: true });
          if (!RETRY_STATUS.has(response.status) || !safeToRepeat || attempt === maxAttempts) return response;
          await sleepImpl(retryDelay(attempt, response, random));
        } catch (error) {
          lastError = new CloudflareRequestError(`${operation} failed via curl: network error ${networkCode(error) || "ECURL"}`, { operation, endpoint: new URL(url).pathname, method, attempt, transport: "curl", networkCode: networkCode(error) || "ECURL", mayHaveReached: !SAFE_METHODS.has(method), reconciliationAttempted: false });
        }
      }
      if (!safeToRepeat) break;
    }
    lastError.remediation = lastError.mayHaveReached ? "Discover the resource and reconcile its verified state before retrying." : "Check DNS/network connectivity and retry setup.";
    throw lastError;
  };
}

export function client(token, account, options = {}) {
  if (!token) throw Error("CLOUDFLARE_API_TOKEN is required");
  const transport = options.transport || createTransport(options);
  let lastTransport;
  const headers = init => ({ authorization: `Bearer ${token}`, ...(!(init.body instanceof FormData) && { "content-type": "application/json" }), ...init.headers });
  async function raw(pathname, init = {}) {
    const response = await transport(`${base}${pathname}`, { ...init, headers: headers(init), operation: init.operation });
    lastTransport = response.avosTransport;
    if (!response.ok) {
      const body = await response.text();
      let parsed = {}; try { parsed = JSON.parse(body); } catch { /* reporting uses sanitized raw text */ }
      const codes = (parsed.errors || []).map(item => item.code).filter(Boolean);
      throw new CloudflareRequestError(`${init.operation || "Cloudflare request"}: ${init.method || "GET"} ${pathname} failed with HTTP ${response.status}${codes.length ? ` (codes ${codes.join(",")})` : ""}: ${sanitize((parsed.errors || []).map(item => item.message).join(", ") || body)}`, { operation: init.operation, endpoint: pathname, method: init.method || "GET", status: response.status, codes, responseBody: sanitize(body), attempt: response.avosAttempt, transport: response.avosTransport, mayHaveReached: true, reconciliationAttempted: false, remediation: response.status === 401 || response.status === 403 ? "Correct the token or its scoped permissions; this failure is not retried." : "Correct the request or Cloudflare configuration before retrying." });
    }
    return response;
  }
  async function call(pathname, init = {}) {
    const response = await raw(pathname, init);
    const payload = await response.json().catch(() => ({}));
    if (payload.success === false) {
      const codes = (payload.errors || []).map(item => item.code).filter(Boolean);
      throw new CloudflareRequestError(`${init.operation || "Cloudflare request"}: ${init.method || "GET"} ${pathname} failed${codes.length ? ` (codes ${codes.join(",")})` : ""}: ${sanitize((payload.errors || []).map(item => item.message).join(", "))}`, { endpoint: pathname, method: init.method || "GET", status: response.status, codes, responseBody: sanitize(JSON.stringify(payload)), transport: response.avosTransport, mayHaveReached: true });
    }
    return payload.result;
  }
  return { call, raw, transport, account, get lastTransport() { return lastTransport; } };
}

export const requiredPermissions = ["Workers Scripts Write", "Workers Scripts Read", "D1 Write", "D1 Read", "Workers KV Storage Write", "Workers KV Storage Read", "Queues Write", "Queues Read"];
export async function verifyPermissions(c) {
  const checks = [];
  const run = async (name, path) => { const result = await c.call(path, { operation: name }); checks.push({ name, transport: c.lastTransport || "custom", result }); return result; };
  const verify = await run("verify API token", "/user/tokens/verify");
  if (verify.status !== "active") throw Error("Cloudflare API token is not active");
  const account = `/accounts/${c.account}`;
  await run("list D1 databases", `${account}/d1/database`);
  await run("list KV namespaces", `${account}/storage/kv/namespaces`);
  await run("list Queues", `${account}/queues`);
  await run("list Worker scripts", `${account}/workers/scripts`);
  return { missing: [], checks };
}
