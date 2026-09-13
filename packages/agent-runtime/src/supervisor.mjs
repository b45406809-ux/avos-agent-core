import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { AgentRuntime } from "./runtime.mjs";

const exec = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export class RunnerSupervisor {
  constructor(options = {}) {
    this.origin = options.origin || process.env.CONTROL_PLANE_ORIGIN;
    this.runId = options.runId || process.env.RUN_ID;
    this.correlationId = options.correlationId || process.env.CORRELATION_ID;
    this.fetch = options.fetch || fetch;
    this.lease = null; this.stopped = false; this.finished = false; this.sequence = 0;
    this.idleMs = options.idleMs || Number(process.env.WARM_IDLE_MS || 180000);
    this.refreshing = null; this.child = null;
  }
  async oidc() {
    const url = process.env.ACTIONS_ID_TOKEN_REQUEST_URL, token = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    if (!url || !token) throw Error("GitHub OIDC environment unavailable");
    const response = await this.fetch(`${url}&audience=${encodeURIComponent(process.env.OIDC_AUDIENCE || "avos-runner")}`, { headers: { authorization: `Bearer ${token}` } });
    if (!response.ok) throw Error("Unable to obtain GitHub OIDC token");
    return (await response.json()).value;
  }
  async register() {
    const response = await this.fetch(`${this.origin}/api/runner/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ schemaVersion: 1, runId: this.runId, correlationId: this.correlationId, githubRunId: process.env.GITHUB_RUN_ID, oidcToken: await this.oidc() }) });
    if (!response.ok) throw Error(`Runner registration failed (${response.status})`);
    this.lease = await response.json();
  }
  async refresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const response = await this.fetch(`${this.origin}/api/runner/heartbeat`, { method: "POST", headers: { authorization: `Bearer ${this.lease.token}`, "content-type": "application/json" }, body: JSON.stringify({ runId: this.runId }) });
      if (!response.ok) throw Error(`Lease refresh failed (${response.status})`);
      this.lease = { ...this.lease, ...(await response.json()) };
    })().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }
  async api(route, init = {}) {
    if (this.lease.expiresAt && Date.parse(this.lease.expiresAt) - Date.now() < 90000) await this.refresh();
    const response = await this.fetch(`${this.origin}${route}`, { ...init, headers: { ...init.headers, authorization: `Bearer ${this.lease.token}` } });
    if (!response.ok) throw Error(`Control plane ${route} failed (${response.status})`);
    return response;
  }
  async document(route, attempts = 6) {
    let delay = 250;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (this.lease.expiresAt && Date.parse(this.lease.expiresAt) - Date.now() < 90000) await this.refresh();
      const response = await this.fetch(`${this.origin}${route}`, { headers: { authorization: `Bearer ${this.lease.token}` } });
      if (response.ok || response.status !== 503) return response;
      await sleep(delay); delay = Math.min(4000, delay * 2);
    }
    throw Error(`Document ${route} remained unavailable after bounded retries`);
  }
  async emit(eventType, payload, agentId = "runner") {
    await this.api("/api/runner/events", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ events: [{ schemaVersion: 1, eventId: `evt_${crypto.randomUUID().replaceAll("-", "")}`, localSequence: ++this.sequence, runId: this.runId, agentId, eventType, timestamp: new Date().toISOString(), payload }] }) });
  }
  async checkpoint(runtime) {
    const directory = path.resolve(process.env.WORKSPACE_DIR || ".", ".agent");
    const data = JSON.stringify(runtime.checkpoint(process.env.STARTING_COMMIT || "unknown"), null, 2);
    await fs.mkdir(directory, { recursive: true }); await fs.writeFile(path.join(directory, "checkpoint.json"), data);
    await this.api("/api/runner/checkpoints", { method: "POST", headers: { "content-type": "application/json", "x-repository-revision": process.env.STARTING_COMMIT || "unknown", "x-checkpoint-boundary": this.stopped ? "cancelled" : "verified" }, body: data });
    await this.emit("checkpoint_saved", { summary: "Remote checkpoint persisted" });
  }
  async commands(runtime) {
    const rows = await (await this.api("/api/runner/commands")).json();
    for (const command of rows) {
      const payload = JSON.parse(command.payload_json);
      if (command.type === "cancel") { this.stopped = true; runtime.cancel(); this.child?.kill("SIGTERM"); }
      else if (command.type === "interrupt") runtime.interrupt(payload.guidance);
      else if (command.type === "permission_decision") runtime.emit("permission-decision", payload);
      else if (command.type === "follow_up") runtime.interrupt(payload.message || payload.guidance);
      else if (command.type === "release_runner") this.stopped = true;
      await this.api("/api/runner/ack", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ commandId: command.id }) });
    }
  }
  async poll(runtime, until) {
    let delay = 1000;
    while (!this.finished && !until() && !this.stopped) {
      await this.commands(runtime); await sleep(delay); delay = Math.min(15000, Math.round(delay * 1.7));
    }
  }
  async warm(runtime) {
    const end = Date.now() + this.idleMs;
    await this.commands(runtime);
    await this.poll(runtime, () => Date.now() >= end);
    await this.checkpoint(runtime);
  }
  async start({ mission, execute }) {
    if (!this.lease) await this.register();
    const runtime = new AgentRuntime({ mission, modelCapability: { contextWindow: 128000, maxOutputTokens: 8192, safeReservePercent: 20 }, execute });
    runtime.on("progress", value => void this.emit("progress", value));
    runtime.on("permission-request", value => void this.api("/api/runner/permissions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) }));
    const polling = this.poll(runtime, () => this.finished);
    await runtime.run({ id: "root", mission }); this.finished = true; await polling;
    await this.checkpoint(runtime);
    return runtime;
  }
}

async function github(token, route, init = {}) {
  const response = await fetch(`https://api.github.com${route}`, { ...init, headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "content-type": "application/json", "user-agent": "AVOS-Runner", "x-github-api-version": "2022-11-28", ...init.headers } });
  if (!response.ok) throw Error(`GitHub ${route} failed (${response.status})`);
  return response.status === 204 ? null : response.json();
}

async function publish(workspace, mission, credential, runId) {
  const branch = `avos/${runId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  const status = await exec("git", ["status", "--porcelain"], { cwd: workspace });
  if (!status.stdout.trim()) throw Error("Verified mission produced no repository changes");
  await exec("git", ["config", "user.name", "AVOS Agent"], { cwd: workspace });
  await exec("git", ["config", "user.email", "avos-agent@users.noreply.github.com"], { cwd: workspace });
  await exec("git", ["checkout", "-b", branch], { cwd: workspace });
  await exec("git", ["add", "--all"], { cwd: workspace });
  await exec("git", ["commit", "-m", `AVOS mission ${runId}`], { cwd: workspace });
  await exec("git", ["push", `https://x-access-token:${credential.token}@github.com/${mission.repository}.git`, `HEAD:refs/heads/${branch}`], { cwd: workspace, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  const pull = await github(credential.token, `/repos/${mission.repository}/pulls`, { method: "POST", body: JSON.stringify({ title: `AVOS mission ${runId}`, head: branch, base: mission.branch, body: `Automated, verified changes for AVOS run \`${runId}\`.` }) });
  return { number: pull.number, url: pull.html_url, branch };
}

async function main() {
  const supervisor = new RunnerSupervisor(); await supervisor.register();
  const mission = await (await supervisor.api("/api/runner/mission")).json();
  const prompt = await (await supervisor.document(mission.prompt.url)).text();
  if (crypto.createHash("sha256").update(prompt).digest("hex") !== mission.checksum) throw Error("Mission prompt checksum mismatch");
  const workspace = path.resolve(process.env.WORKSPACE_DIR || "workspace"); await fs.rm(workspace, { recursive: true, force: true });
  const credential = await (await supervisor.api("/api/runner/credentials/repository", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ repository: mission.repository }) })).json();
  const provider = await (await supervisor.api("/api/runner/credentials/providers", { method: "POST" })).json();
  Object.assign(process.env, provider.credentials);
  await exec("git", ["clone", "--depth", "1", "--branch", mission.branch, `https://x-access-token:${credential.token}@github.com/${mission.repository}.git`, workspace], { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  await exec("git", ["remote", "set-url", "origin", `https://github.com/${mission.repository}.git`], { cwd: workspace });
  Object.assign(process.env, { WORKSPACE_DIR: workspace, TARGET_REPO: mission.repository, TARGET_BRANCH: mission.branch, USER_PROMPT: prompt, STARTING_COMMIT: (await exec("git", ["rev-parse", "HEAD"], { cwd: workspace })).stdout.trim() });
  const restored = await supervisor.document("/api/runner/checkpoint");
  if (restored.status !== 204) { const checkpoint = await restored.json(); if (checkpoint.schemaVersion !== 1 || checkpoint.missionRef !== mission.checksum || checkpoint.repositoryRevision !== process.env.STARTING_COMMIT) throw Error("Remote checkpoint validation failed"); }
  await supervisor.emit("checkout", { summary: "Target repository checked out", startingCommit: process.env.STARTING_COMMIT });
  const execute = () => new Promise((resolve, reject) => {
    supervisor.child = spawn(process.execPath, [path.resolve("packages/agent-runtime/src", mission.specification.executionMode === "swarm" ? "swarm.mjs" : "agent.mjs")], { stdio: "inherit", env: process.env });
    supervisor.child.once("exit", code => supervisor.stopped ? resolve({ summary: "Cancelled" }) : code === 0 ? resolve({ summary: "Agent completed and verification passed" }) : reject(Error(`Agent loop exited ${code}`)));
  });
  try {
    const runtime = await supervisor.start({ mission: { checksum: mission.checksum, successCriteria: mission.specification.requirements || [] }, execute });
    if (supervisor.stopped) { await supervisor.api("/api/runner/finalize", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "cancelled", summary: "Cancelled before publication" }) }); return runtime; }
    const pull = await publish(workspace, mission, credential, supervisor.runId); await supervisor.emit("pull_request", pull);
    await supervisor.api("/api/runner/finalize", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "completed", summary: "Verified changes published", pullRequest: pull }) });
    return runtime;
  } catch (error) {
    if (supervisor.lease && !supervisor.stopped) await supervisor.api("/api/runner/finalize", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "failed", summary: String(error) }) }).catch(() => {});
    throw error;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch(error => { console.error(String(error).replace(/https:\/\/[^@]+@/g, "https://[REDACTED]@")); process.exitCode = 1; });
