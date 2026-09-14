import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { hash as blake3 } from "blake3-wasm";
import { createHash, randomBytes } from "node:crypto";
import readline from "node:readline/promises";
import { client, verifyPermissions } from "./cloudflare-api.mjs";

const exec = promisify(execFile);
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const c = client(process.env.CLOUDFLARE_API_TOKEN, account);
const script = "avos-control-plane";
const dryRun = process.argv.includes("--dry-run");
const resume = process.argv.includes("--resume");
if (!account) throw Error("CLOUDFLARE_ACCOUNT_ID is required");
if (!process.env.CLOUDFLARE_API_TOKEN) throw Error("CLOUDFLARE_API_TOKEN is required");
let ownerInput = process.env.BOOTSTRAP_OWNER_GITHUB_ID;
if (!ownerInput && process.stdin.isTTY) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  ownerInput = await rl.question("Bootstrap owner GitHub numeric ID or login: ");
  rl.close();
}
if (!ownerInput) throw Error("BOOTSTRAP_OWNER_GITHUB_ID is required (a numeric ID or GitHub login)");

async function githubJson(url, retries = 3) {
  const headers = {
    accept: "application/vnd.github+json",
    "user-agent": "AVOS-Bootstrap"
  };
  if (process.env.GITHUB_TOKEN) {
    headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, { headers });
      if (response.ok) return await response.json();
      if (response.status >= 500 && attempt < retries) {
        await new Promise(r => setTimeout(r, 2000 * attempt));
        continue;
      }
      throw Error(`GitHub discovery failed (${response.status})`);
    } catch (err) {
      if (attempt >= retries) throw err;
      await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }
}

let ownerId = ownerInput, ownerLogin;
if (!/^\d+$/.test(ownerInput)) {
  const user = await githubJson(`https://api.github.com/users/${encodeURIComponent(ownerInput)}`);
  ownerId = String(user.id);
  ownerLogin = user.login;
} else {
  ownerLogin = (await githubJson(`https://api.github.com/user/${ownerInput}`)).login;
}
const remote = (await exec("git", ["config", "--get", "remote.origin.url"])).stdout.trim(),
  repositoryMatch = remote.match(/github\.com[/:]([^/]+\/[^/.]+)(?:\.git)?$/),
  controlRepository = process.env.CONTROL_REPOSITORY || repositoryMatch?.[1];
if (!controlRepository) throw Error("The control repository could not be derived from the git origin");
const repository = await githubJson(`https://api.github.com/repos/${controlRepository}`),
  defaultBranch = repository.default_branch;
const oidcAudience = process.env.OIDC_AUDIENCE || "avos-runner",
  workflowRef = `${controlRepository}/.github/workflows/agent.yml@refs/heads/${defaultBranch}`;
const generated = {
  SESSION_HMAC_KEY: randomBytes(32).toString("base64"),
  CREDENTIAL_KEK: randomBytes(32).toString("base64"),
  SETUP_NONCE: randomBytes(32).toString("base64url")
};
const setupNonceHash = createHash("sha256").update(generated.SETUP_NONCE).digest("hex"),
  setupExpires = Date.now() + 15 * 60 * 1000;
const preflight = await verifyPermissions(c);
console.log(`Connectivity preflight passed: ${preflight.checks.map(check => `${check.name} via ${check.transport}`).join(", ")}.`);
const api = value => `/accounts/${account}${value}`;
async function named(listPath, name, create, field = "name") {
  const discover = async () => (await c.call(api(listPath), { operation: `discover ${name}` })).find?.(item => item[field] === name);
  const existing = await discover();
  if (existing || dryRun) return existing;
  try {
    await c.call(api(listPath), { method: "POST", body: JSON.stringify(create), operation: `create ${name}` });
  } catch (error) {
    error.reconciliationAttempted = true;
    const reconciled = await discover();
    if (reconciled) return reconciled;
    if (error.mayHaveReached) throw error;
    await c.call(api(listPath), { method: "POST", body: JSON.stringify(create), operation: `create ${name} after reconciliation` });
  }
  const verified = await discover();
  if (!verified) throw Error(`Cloudflare accepted ${name}, but it was not present during verification`);
  return verified;
}

const db = await named("/d1/database", "avos_swarm_db", { name: "avos_swarm_db" });
const namespace = await named("/storage/kv/namespaces", "avos-agent-documents", { title: "avos-agent-documents" }, "title");
const queue = await named("/queues", "avos-agent-dispatch", { queue_name: "avos-agent-dispatch" }, "queue_name");

const intendedBindings = ["DB (D1: avos_swarm_db)", "DOCUMENTS (KV: avos-agent-documents)", "DISPATCH_QUEUE (Queue: avos-agent-dispatch)", "RUNS (Durable Object)", "ASSETS (Workers Static Assets)"];
if (dryRun) {
  console.log(JSON.stringify({ mode: "dry-run", resources: {
    d1: db ? `reuse ${db.name}` : "create avos_swarm_db",
    kv: namespace ? `reuse ${namespace.title}` : "create avos-agent-documents",
    queue: queue ? `reuse ${queue.queue_name}` : "create avos-agent-dispatch",
    worker: `create or update ${script}`
  }, bindings: intendedBindings, mutationsIssued: 0 }, null, 2));
  process.exit(0);
}

await fs.mkdir(".avos", { recursive: true });
const progressPath = ".avos/deployment.json";
let progress = {};
if (resume) try { progress = JSON.parse(await fs.readFile(progressPath, "utf8")); } catch { /* discovery remains authoritative */ }
const migrationFiles = (await fs.readdir("migrations")).filter(name => name.endsWith(".sql")).sort();
const migrationChecksum = createHash("sha256");
for (const file of migrationFiles) migrationChecksum.update(file).update(await fs.readFile(path.join("migrations", file)));
const configurationChecksum = migrationChecksum.update(JSON.stringify({ script, d1: db.uuid, kv: namespace.id, queue: queue.queue_id || queue.id, bindings: intendedBindings })).digest("hex");
async function saveProgress(extra = {}) {
  progress = { d1: { name: db.name, id: db.uuid }, kv: { title: namespace.title, id: namespace.id }, queue: { name: queue.queue_name, id: queue.queue_id || queue.id }, worker: { name: script, ...(progress.worker || {}) }, appliedMigrations: progress.appliedMigrations || [], configurationChecksum, ...extra };
  await fs.writeFile(progressPath, JSON.stringify(progress, null, 2), { mode: 0o600 });
}
await saveProgress();

await c.call(api(`/d1/database/${db.uuid}/query`), { method: "POST", operation: "ensure migration ledger", body: JSON.stringify({ sql: "CREATE TABLE IF NOT EXISTS avos_migrations (version TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL)" }) });
const ledgerResult = await c.call(api(`/d1/database/${db.uuid}/query`), { method: "POST", operation: "inspect migration ledger", body: JSON.stringify({ sql: "SELECT version, checksum FROM avos_migrations ORDER BY version" }) });
const ledger = new Map((ledgerResult?.[0]?.results || ledgerResult?.results || []).map(row => [row.version, row.checksum]));
const migrationSignatures = {
  "0001_durable_kernel.sql": ["organizations:id", "events:sequence", "idempotency_keys:key"],
  "0002_control_plane.sql": ["missions:prompt_object_key", "runs:correlation_id", "runner_leases:expires_at", "run_commands:idempotency_key"],
  "0003_single_owner_runtime.sql": ["runner_leases:previous_token_hash", "mission_attachments:mission_id", "runs:parent_run_id"],
  "0004_kv_document_store.sql": ["documents:kv_key", "missions:prompt_document_id", "artifact_metadata:purpose"]
};
async function signatureExists(signature) {
  const [table, column] = signature.split(":");
  const result = await c.call(api(`/d1/database/${db.uuid}/query`), { method: "POST", operation: `inspect existing ${table} schema`, body: JSON.stringify({ sql: `PRAGMA table_info(${table})` }) });
  return (result?.[0]?.results || result?.results || []).some(row => row.name === column);
}
for (const file of migrationFiles) {
  const sql = await fs.readFile(path.join("migrations", file), "utf8");
  const checksum = createHash("sha256").update(sql).digest("hex");
  if (ledger.has(file)) {
    if (ledger.get(file) !== checksum) throw Error(`Migration ${file} changed after it was applied; refusing destructive reconciliation`);
    continue;
  }
  const signatures = migrationSignatures[file] || [];
  if (signatures.length && (await Promise.all(signatures.map(signatureExists))).every(Boolean)) {
    await c.call(api(`/d1/database/${db.uuid}/query`), { method: "POST", operation: `adopt migration ${file}`, body: JSON.stringify({ sql: "INSERT INTO avos_migrations(version, checksum, applied_at) VALUES (?1, ?2, ?3)", params: [file, checksum, Date.now()] }) });
    ledger.set(file, checksum);
    progress.appliedMigrations = [...new Set([...(progress.appliedMigrations || []), file])];
    await saveProgress();
    continue;
  }
  if (/\bDROP\s+(TABLE|COLUMN)|\bDELETE\s+FROM|\bTRUNCATE\b/i.test(sql)) throw Error(`Migration ${file} contains a destructive statement`);
  await c.call(api(`/d1/database/${db.uuid}/query`), { method: "POST", operation: `apply migration ${file}`, body: JSON.stringify({ sql }) });
  await c.call(api(`/d1/database/${db.uuid}/query`), { method: "POST", operation: `record migration ${file}`, body: JSON.stringify({ sql: "INSERT INTO avos_migrations(version, checksum, applied_at) VALUES (?1, ?2, ?3)", params: [file, checksum, Date.now()] }) });
  progress.appliedMigrations = [...new Set([...(progress.appliedMigrations || []), file])];
  await saveProgress();
}

const requiredSchema = { missions: ["prompt_object_key", "prompt_document_id"], runs: ["correlation_id", "latest_sequence", "checkpoint_id"], attachments: ["mime_type", "size_bytes", "checksum"], runner_leases: ["run_id", "expires_at"], run_commands: ["idempotency_key"], permission_requests: ["status"], artifact_metadata: ["object_key", "checksum"], idempotency_keys: ["scope", "key"] };
for (const [table, columns] of Object.entries(requiredSchema)) {
  const result = await c.call(api(`/d1/database/${db.uuid}/query`), { method: "POST", operation: `verify ${table} schema`, body: JSON.stringify({ sql: `PRAGMA table_info(${table})` }) });
  const actual = new Set((result?.[0]?.results || result?.results || []).map(row => row.name));
  const missing = columns.filter(column => !actual.has(column));
  if (missing.length) throw Error(`Migration verification failed: ${table} lacks ${missing.join(", ")}`);
}

await exec("npm", ["run", "build"]);
await exec("node_modules/.bin/esbuild", ["apps/control-plane/src/index.ts", "--bundle", "--format=esm", "--platform=browser", "--outfile=.avos/worker.mjs"]);

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
    const assetPath = "/" + name.replaceAll(path.sep, "/").replace(/^\/+/, "");
    entries.push({ name: assetPath, absolute, bytes, hash: digest, size: stat.size });
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

const workersSubdomain = await c.call(api("/workers/subdomain"), { operation: "discover workers.dev subdomain" });
const workerUrl = workersSubdomain?.subdomain ? `https://${script}.${workersSubdomain.subdomain}.workers.dev` : undefined;
if (!workerUrl) throw Error("The workers.dev subdomain could not be discovered");
const assetsJwt = await uploadAssets("apps/web/dist");
const source = await fs.readFile(".avos/worker.mjs");
const plain = {
  OWNER_GITHUB_LOGIN: ownerLogin, OWNER_GITHUB_ID: ownerId,
  CONTROL_REPOSITORY: controlRepository, CONTROL_REPOSITORY_DEFAULT_BRANCH: defaultBranch,
  OIDC_AUDIENCE: oidcAudience, AVOS_PRODUCTION_ORIGIN: workerUrl, GITHUB_WORKFLOW_REF: workflowRef,
  SETUP_NONCE_EXPIRES_AT: String(setupExpires),
  ENVIRONMENT: "production", FREE_ONLY_MODE: "true", MAX_KV_WRITES_PER_DAY: "800",
  MAX_D1_WRITES_PER_DAY: "80000", MAX_D1_ROWS_READ_PER_DAY: "4000000",
  MAX_GITHUB_MINUTES_PER_MONTH: "1500", MAX_ATTACHMENT_BYTES: "20971520",
  MAX_MISSION_ATTACHMENT_BYTES: "52428800", MAX_PROMPT_BYTES: "2097152", TEMP_DOCUMENT_DAYS: "10"
};
const secrets = { SESSION_HMAC_KEY: generated.SESSION_HMAC_KEY, CREDENTIAL_KEK: generated.CREDENTIAL_KEK, SETUP_NONCE_HASH: setupNonceHash };
const bindings = [
  { type: "d1", name: "DB", id: db.uuid },
  { type: "kv_namespace", name: "DOCUMENTS", namespace_id: namespace.id },
  { type: "queue", name: "DISPATCH_QUEUE", queue_name: queue.queue_name },
  { type: "durable_object_namespace", name: "RUNS", class_name: "RunCoordinator" },
  { type: "assets", name: "ASSETS" },
  ...Object.entries(plain).filter(([, text]) => text).map(([name, text]) => ({ type: "plain_text", name, text })),
  ...Object.entries(secrets).map(([name, text]) => ({ type: "secret_text", name, text }))
];
const metadata = {
  main_module: "worker.mjs", compatibility_date: "2025-03-10", bindings,
  migrations: { new_tag: "v1", new_sqlite_classes: ["RunCoordinator"] },
  assets: { jwt: assetsJwt, config: { run_worker_first: ["/api/*"] } }
};
const form = new FormData();
form.set("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
form.set("worker.mjs", new Blob([source], { type: "application/javascript+module" }), "worker.mjs");
await c.call(api(`/workers/scripts/${script}`), { method: "PUT", body: form });
const deployedScripts = await c.call(api("/workers/scripts"), { operation: "verify Worker upload" });
if (!deployedScripts.some(item => (item.id || item.name) === script)) throw Error("Worker upload could not be verified; it will not be repeated blindly");
await c.call(api(`/workers/scripts/${script}/subdomain`), { method: "POST", body: JSON.stringify({ enabled: true }) });

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
await saveProgress({ worker: { name: script, url: workerUrl }, deployedAt: new Date().toISOString() });
console.log(JSON.stringify({ database: "avos_swarm_db", script, setupUrl: `${workerUrl}/setup/github/start?nonce=${generated.SETUP_NONCE}`, setupExpiresAt: new Date(setupExpires).toISOString(), next: "Open the one-time setup URL, then revoke this deployment token unless automated updates require it. For automated updates, store it only as a GitHub Actions secret in your fork." }, null, 2));
generated.SETUP_NONCE = ""; generated.SESSION_HMAC_KEY = ""; generated.CREDENTIAL_KEK = "";