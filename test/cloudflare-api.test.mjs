import test from "node:test";
import assert from "node:assert/strict";
import { client, CloudflareRequestError, createTransport, sanitize } from "../scripts/cloudflare-api.mjs";

const ok = (body = { success: true, result: { ok: true } }, status = 200, headers) => new Response(JSON.stringify(body), { status, headers });
const networkError = code => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(code), { code }) });

test("native fetch succeeds and reports selected transport", async () => {
  let calls = 0;
  const transport = createTransport({ fetchImpl: async () => { calls++; return ok(); }, sleepImpl: async () => {} });
  const response = await transport("https://api.cloudflare.com/client/v4/test");
  assert.equal(calls, 1);
  assert.equal(response.avosTransport, "native-auto");
});

test("IPv6 ENETUNREACH retries with the IPv4 dispatcher", async () => {
  let calls = 0;
  const transport = createTransport({ maxAttempts: 3, sleepImpl: async () => {}, fetchImpl: async (_url, init) => {
    calls++;
    if (calls === 1) throw networkError("ENETUNREACH");
    assert(init.dispatcher);
    return ok();
  } });
  const response = await transport("https://api.cloudflare.com/client/v4/test");
  assert.equal(response.avosTransport, "native-ipv4");
  assert.equal(calls, 2);
});

test("transient timeout is retried", async () => {
  let calls = 0;
  const transport = createTransport({ maxAttempts: 3, sleepImpl: async () => {}, fetchImpl: async () => {
    if (++calls === 1) throw Object.assign(new DOMException("timed out", "TimeoutError"), { code: "ETIMEDOUT" });
    return ok();
  } });
  assert.equal((await transport("https://api.cloudflare.com/client/v4/test")).status, 200);
  assert.equal(calls, 2);
});

test("429 honors retry-after before retrying", async () => {
  const delays = [];
  let calls = 0;
  const transport = createTransport({ random: () => 0, sleepImpl: async delay => delays.push(delay), fetchImpl: async () => ++calls === 1 ? ok({}, 429, { "retry-after": "2" }) : ok() });
  assert.equal((await transport("https://api.cloudflare.com/client/v4/test")).status, 200);
  assert.deepEqual(delays, [2000]);
});

test("permanent 401 is not retried and preserves safe Cloudflare details", async () => {
  let calls = 0;
  const c = client("top-secret", "account", { fetchImpl: async () => { calls++; return ok({ success: false, errors: [{ code: 10000, message: "permission denied" }] }, 401); } });
  await assert.rejects(c.call("/accounts/account/workers/scripts", { operation: "list scripts" }), error => {
    assert(error instanceof CloudflareRequestError);
    assert.equal(error.status, 401);
    assert.deepEqual(error.codes, [10000]);
    assert(!error.message.includes("top-secret"));
    return true;
  });
  assert.equal(calls, 1);
});

test("diagnostics redact credentials", () => {
  const text = sanitize("Authorization: Bearer token-value client_secret=hunter2 private_key='key-material'");
  assert(!text.includes("token-value"));
  assert(!text.includes("hunter2"));
  assert(!text.includes("key-material"));
});

test("unsafe ambiguous POST is not blindly retried", async () => {
  let calls = 0;
  const transport = createTransport({ maxAttempts: 4, fetchImpl: async () => { calls++; throw networkError("ECONNRESET"); }, curlImpl: async () => { throw Error("must not run"); } });
  await assert.rejects(transport("https://api.cloudflare.com/client/v4/accounts/a/queues", { method: "POST" }), error => error.mayHaveReached === true);
  assert.equal(calls, 1);
});

test("repeated native network failure uses the controlled curl fallback", async () => {
  let nativeCalls = 0, curlCalls = 0;
  const transport = createTransport({ maxAttempts: 2, sleepImpl: async () => {}, fetchImpl: async () => { nativeCalls++; throw networkError("ENETUNREACH"); }, curlImpl: async (_url, init) => {
    curlCalls++;
    assert.equal(init.headers.authorization, "Bearer test-token");
    return ok();
  } });
  const c = client("test-token", "account", { transport });
  assert.deepEqual(await c.call("/test", { operation: "connectivity check" }), { ok: true });
  assert.equal(nativeCalls, 2);
  assert.equal(curlCalls, 1);
  assert.equal(c.lastTransport, "curl");
});
