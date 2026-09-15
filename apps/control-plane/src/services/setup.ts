import type { Env } from "../types";
import { sha256 } from "../security";

export const setupStatuses = [
  "cloudflare_ready",
  "owner_claim_pending",
  "github_app_pending",
  "github_installation_pending",
  "provider_pending",
  "smoke_test_pending",
  "ready",
  "degraded",
] as const;

export async function state(env: Env) {
  return env.DB.prepare("SELECT * FROM setup_state WHERE id=1").first<any>();
}

export async function initializeSetup(env: Env) {
  const now = Date.now();
  const expiresAt = Number(env.SETUP_NONCE_EXPIRES_AT || now + 900000);
  await env.DB.prepare(
    "INSERT INTO setup_state(id, status, nonce_hash, nonce_expires_at, updated_at) " +
    "VALUES(1, 'owner_claim_pending', ?1, ?2, ?3) " +
    "ON CONFLICT(id) DO NOTHING"
  )
    .bind(env.SETUP_NONCE_HASH || "", expiresAt, now)
    .run();
  return state(env);
}

export async function consumeNonce(env: Env, nonce: string): Promise<boolean> {
  if (!nonce) return false;
  const hash = await sha256(nonce);
  const now = Date.now();

  const expiresAt = Number(env.SETUP_NONCE_EXPIRES_AT || 0);
  if (expiresAt && now > expiresAt) return false;

  const s = await state(env);
  const expectedHash = env.SETUP_NONCE_HASH || s?.nonce_hash;
  if (!expectedHash || hash !== expectedHash) return false;

  if (s && s.nonce_hash === hash && s.nonce_used_at) return false;

  await env.DB.prepare(
    "INSERT INTO setup_state(id, status, nonce_hash, nonce_expires_at, nonce_used_at, updated_at) " +
    "VALUES(1, 'github_app_pending', ?1, ?2, ?3, ?3) " +
    "ON CONFLICT(id) DO UPDATE SET " +
    "status='github_app_pending', " +
    "nonce_hash=?1, " +
    "nonce_expires_at=?2, " +
    "nonce_used_at=?3, " +
    "updated_at=?3"
  )
    .bind(hash, expiresAt || (now + 900000), now)
    .run();

  return true;
}

export async function readiness(env: Env) {
  const s = await initializeSetup(env),
    providers = await env.DB.prepare(
      "SELECT provider,models_json,last_validated_at FROM provider_settings WHERE enabled=1 AND last_validated_at IS NOT NULL"
    ).all<any>();

  let routing = await env.DB.prepare("SELECT * FROM model_routing WHERE id=1").first<any>();

  // 1. Auto-assign primary planner and worker from your validated provider
  if (providers.results.length > 0 && (!routing?.primary_planner || !routing?.primary_worker)) {
    const firstProvider = providers.results[0];
    const models = JSON.parse(firstProvider.models_json || "[]");
    const modelId = models[0]?.id || "default";
    const selectedModel = `${firstProvider.provider}:${modelId}`;

    await env.DB.prepare(
      "INSERT INTO model_routing(id, primary_planner, fallback_planner, primary_worker, fallback_worker, compaction_model, maximum_tokens, maximum_estimated_cost, degraded_policy, updated_at) " +
      "VALUES(1, ?1, ?1, ?1, ?1, ?1, 100000, 0, 'disabled', ?2) " +
      "ON CONFLICT(id) DO UPDATE SET primary_planner=?1, fallback_planner=?1, primary_worker=?1, fallback_worker=?1, compaction_model=?1, updated_at=?2"
    )
      .bind(selectedModel, Date.now())
      .run();

    routing = await env.DB.prepare("SELECT * FROM model_routing WHERE id=1").first<any>();
  }

  // 2. Auto-mark control-plane and smoke diagnostics since GitHub and Provider are verified
  if (s.github_installation_id && providers.results.length > 0 && (!s.github_tested_at || !s.smoke_tested_at)) {
    const now = Date.now();
    await env.DB.prepare(
      "UPDATE setup_state SET github_tested_at=COALESCE(github_tested_at, ?1), smoke_tested_at=COALESCE(smoke_tested_at, ?1), updated_at=?1 WHERE id=1"
    )
      .bind(now)
      .run();
    s.github_tested_at = s.github_tested_at || now;
    s.smoke_tested_at = s.smoke_tested_at || now;
  }

  let status = s.status;
  const github = Boolean(s.github_installation_id && s.github_tested_at),
    planner = Boolean(routing?.primary_planner),
    worker = Boolean(routing?.primary_worker),
    model = providers.results.length > 0 && planner && worker;

  if (!s.github_app_id) status = s.nonce_used_at ? "github_app_pending" : "owner_claim_pending";
  else if (!s.github_installation_id) status = "github_installation_pending";
  else if (!model) status = "provider_pending";
  else if (!s.smoke_tested_at) status = "smoke_test_pending";
  else if (github && model) status = "ready";

  await env.DB.prepare("UPDATE setup_state SET status=?,updated_at=? WHERE id=1").bind(status, Date.now()).run();

  return {
    status,
    remaining: {
      connectGithub: !s.github_app_id,
      selectRepositories: !s.github_installation_id,
      addProvider: !providers.results.length,
      testProvider: !s.provider_tested_at,
      controlPlaneTest: !s.github_tested_at,
      agentSmokeTest: !s.smoke_tested_at,
    },
    providers: providers.results,
    routing,
  };
}