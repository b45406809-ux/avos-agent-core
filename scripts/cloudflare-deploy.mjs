import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { hash as blake3 } from "blake3-wasm";
import { client, verifyPermissions } from "./cloudflare-api.mjs";

const exec = promisify(execFile);
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const c = client(process.env.CLOUDFLARE_API_TOKEN, account);
const script = "avos-control-plane";
if (!account) throw Error("CLOUDFLARE_ACCOUNT_ID is required");
await verifyPermissions(c);
const api = value => `/accounts/${account}${value}`;

async function named(listPath, name, create, field = "name") {
  const list = await c.call(api(listPath));
  return (list.result || list).find?.(item => item[field] === name) ||
    c.call(api(listPath), { method: "POST", body: JSON.stringify(create) });
}

const db = await named("/d1/database", "avos_swarm_db", { name: "avos_swarm_db" });
const namespace = await named("/storage/kv/namespaces", "avos-agent-documents", { title: "avos-agent-documents" }, "title");
const queue = await named("/queues", "avos-agent-dispatch", { queue_name: "avos-agent-dispatch" }, "queue_name");

for (const file of (await fs.readdir("migrations")).filter(name => name.endsWith(".sql")).sort()) {
  const sql = await fs.readFile(path.join("migrations", file), "utf8");
  try {
    await c.call(api(`/d1/database/${db.uuid}/query`), { method: "POST", body: JSON.stringify({ sql }) });
  } catch (error) {
    if (!/duplicate column|already exists/i.test(String(error))) throw error;
  }
}

await exec("npm", ["run", "build"]);
await fs.mkdir(".avos", { recursive: true });
await exec("node_modules/.bin/esbuild", ["apps/control-plane/src/index.ts", "--bundle", "--format=esm", "--platform=browser", "--outfile=.avos/worker.mjs"]);

// Workers Static Assets are uploaded with the REST asset-session protocol. The
// resulting short-lived JWT is attached to the Worker upload; no Pages project
// or R2 bucket is involved.
async function uploadAssets(directory) {
  const names = (await fs.readdir(directory, { recursive: true })).sort();
  const entries = [];
  for (const name of names) {
    const absolute = path.join(directory, name);
    const stat = await fs.stat(absolute);
    if (!stat.isFile()) continue;
    const bytes = await fs.readFile(absolute);
    const extension = path.extname(name).slice(1);
    const digest = Buffer.from(blake3(bytes.toString("base64") + extension)).toString("hex").slice(0, 32);
    entries.push({ name: name.replaceAll(path.sep, "/"), absolute, bytes, hash: digest, size: stat.size });
  }
  const manifest = Object.fromEntries(entries.map(({ name, hash, size }) => [name, { hash, size }]));
  const session = await c.call(api(`/workers/scripts/${script}/assets-upload-session`), {
    method: "POST", body: JSON.stringify({ manifest })
  });
  let jwt = session.jwt;
  const requested = new Set((session.buckets || []).flat());
  for (const entry of entries.filter(item => requested.has(item.hash))) {
    const response = await c.raw(api(`/workers/assets/upload/${entry.hash}`), {
      method: "POST",
      headers: { authorization: `Bearer ${session.jwt}`, "content-type": mime(entry.name) },
      body: entry.bytes
    });
    if (!response.ok) throw Error(`Static asset upload failed (${response.status})`);
    const body = await response.json();
    jwt = body.result?.jwt || body.jwt || jwt;
  }
  if (!jwt) throw Error("Cloudflare did not return a static-assets completion token");
  return jwt;
}

function mime(name) {
  if (name.endsWith(".html")) return "text/html; charset=utf-8";
  if (name.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (name.endsWith(".css")) return "text/css; charset=utf-8";
  if (name.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

const assetsJwt = await uploadAssets("apps/web/dist");
const source = await fs.readFile(".avos/worker.mjs");
const plain = {
  OWNER_GITHUB_LOGIN: process.env.OWNER_GITHUB_LOGIN,
  OWNER_GITHUB_ID: process.env.OWNER_GITHUB_ID,
  CONTROL_REPOSITORY: process.env.CONTROL_REPOSITORY,
  CONTROL_REPOSITORY_DEFAULT_BRANCH: process.env.CONTROL_REPOSITORY_DEFAULT_BRANCH || "main",
  GITHUB_APP_ID: process.env.GITHUB_APP_ID,
  GITHUB_APP_INSTALLATION_ID: process.env.GITHUB_APP_INSTALLATION_ID,
  GITHUB_CLIENT_ID: process.env.GITHUB_CLIENT_ID,
  OIDC_AUDIENCE: process.env.OIDC_AUDIENCE || "avos-runner",
  GITHUB_WORKFLOW_REF: process.env.GITHUB_WORKFLOW_REF,
  REPOSITORY_ALLOWLIST: process.env.REPOSITORY_ALLOWLIST,
  ENVIRONMENT: "production", FREE_ONLY_MODE: "true", MAX_KV_WRITES_PER_DAY: "800",
  MAX_D1_WRITES_PER_DAY: "80000", MAX_D1_ROWS_READ_PER_DAY: "4000000",
  MAX_GITHUB_MINUTES_PER_MONTH: process.env.MAX_GITHUB_MINUTES_PER_MONTH || "1500",
  MAX_ATTACHMENT_BYTES: "20971520", MAX_MISSION_ATTACHMENT_BYTES: "52428800",
  MAX_PROMPT_BYTES: "2097152", TEMP_DOCUMENT_DAYS: "10"
};
const secrets = ["GITHUB_APP_PRIVATE_KEY", "GITHUB_CLIENT_SECRET", "SESSION_HMAC_KEY", "CREDENTIAL_KEK", "GEMINI_API_KEYS", "GROQ_API_KEYS", "CEREBRAS_API_KEYS", "OPENROUTER_API_KEYS", "NVIDIA_API_KEYS"];
const bindings = [
  { type: "d1", name: "DB", id: db.uuid },
  { type: "kv_namespace", name: "DOCUMENTS", namespace_id: namespace.id },
  { type: "queue", name: "DISPATCH_QUEUE", queue_name: queue.queue_name },
  { type: "durable_object_namespace", name: "RUNS", class_name: "RunCoordinator" },
  { type: "assets", name: "ASSETS" },
  ...Object.entries(plain).filter(([, text]) => text).map(([name, text]) => ({ type: "plain_text", name, text })),
  ...secrets.filter(name => process.env[name]).map(name => ({ type: "secret_text", name, text: process.env[name] }))
];
const metadata = {
  main_module: "worker.mjs", compatibility_date: "2025-03-10", bindings,
  migrations: { new_tag: "v1", new_sqlite_classes: ["RunCoordinator"] },
  assets: { jwt: assetsJwt, config: { run_worker_first: ["/api/*"] } }
};
const form = new FormData();
form.set("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
form.set("worker.mjs", new Blob([source], { type: "application/javascript" }), "worker.mjs");
await c.call(api(`/workers/scripts/${script}`), { method: "PUT", body: form });
await c.call(api(`/workers/scripts/${script}/subdomain`), { method: "POST", body: JSON.stringify({ enabled: true }) });

// Idempotently attach the Queue consumer so messages reach the Worker's queue handler.
const consumers = await c.call(api(`/queues/${queue.queue_id || queue.id}/consumers`));
if (!(consumers.result || consumers).some?.(item => item.script_name === script)) {
  await c.call(api(`/queues/${queue.queue_id || queue.id}/consumers`), {
    method: "POST", body: JSON.stringify({ type: "worker", script_name: script, settings: { batch_size: 10, max_retries: 4 } })
  });
}

const smoke = `avos-smoke-${Date.now()}`;
await c.raw(api(`/storage/kv/namespaces/${namespace.id}/values/${smoke}`), { method: "PUT", headers: { "content-type": "text/plain" }, body: "ok" });
const read = await (await c.raw(api(`/storage/kv/namespaces/${namespace.id}/values/${smoke}`))).text();
if (read !== "ok") throw Error("KV smoke check returned unexpected content");
await c.raw(api(`/storage/kv/namespaces/${namespace.id}/values/${smoke}`), { method: "DELETE" });
await fs.writeFile(".avos/deployment.json", JSON.stringify({ accountId: account, d1: { name: "avos_swarm_db", id: db.uuid }, kv: { name: "avos-agent-documents", id: namespace.id }, queue: { name: queue.queue_name, id: queue.queue_id || queue.id }, script, freeOnly: true, deployedAt: new Date().toISOString() }, null, 2));
console.log(JSON.stringify({ database: "avos_swarm_db", documents: "avos-agent-documents", queue: queue.queue_name, script, assets: "apps/web/dist", kvSmoke: "passed", freeOnly: true, metadata: ".avos/deployment.json" }, null, 2));
