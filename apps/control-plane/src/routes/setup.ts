import type { Env, Owner } from "../types";
import { json } from "../types";
import { ApiError, readJson } from "../middleware/errors";
import { cookie } from "../middleware/auth";
import { randomId, sha256 } from "../security";
import { consumeNonce, initializeSetup, readiness, state } from "../services/setup";
import { seal } from "../services/vault";

const secure = (n: string, v: string, age: number) =>
  `${n}=${v}; Path=/; Max-Age=${age}; Secure; HttpOnly; SameSite=Lax`;

export async function publicSetupRoutes(req: Request, env: Env) {
  const u = new URL(req.url);
  const p = u.pathname;
  const origin = (env.AVOS_PRODUCTION_ORIGIN && env.AVOS_PRODUCTION_ORIGIN !== "undefined")
    ? env.AVOS_PRODUCTION_ORIGIN
    : u.origin;

  if (p === "/api/setup/status" && req.method === "GET") {
    return json(await readiness(env));
  }

  // Redirect start directly to the clean manual setup page
  if (p === "/setup/github/start" && req.method === "GET") {
    return new Response(null, {
      status: 302,
      headers: { location: "/setup/manual" },
    });
  }

  // GET: Display manual setup page
  if (p === "/setup/manual" && req.method === "GET") {
    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>AVOS - Connect GitHub App</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #080b12; color: #e8ecf4; margin: 0; padding: 1.5rem; display: flex; justify-content: center; }
    .card { max-width: 580px; width: 100%; background: #111620; border: 1px solid #252b39; border-radius: 12px; padding: 2rem; }
    h1 { font-size: 22px; margin-top: 0; color: #76e4bd; }
    p { color: #8e99ac; font-size: 14px; line-height: 1.5; }
    label { display: block; font-size: 13px; font-weight: 600; margin-top: 1rem; color: #c9d1d9; }
    input, textarea { width: 100%; box-sizing: border-box; background: #161c28; border: 1px solid #252b39; border-radius: 6px; padding: 10px; color: #fff; margin-top: 0.35rem; font-family: inherit; }
    textarea { resize: vertical; min-height: 80px; font-family: monospace; font-size: 12px; }
    button { width: 100%; background: #76e4bd; color: #06110d; font-weight: 700; border: none; padding: 12px; border-radius: 8px; font-size: 16px; margin-top: 1.5rem; cursor: pointer; }
    button:hover { background: #5bd2a8; }
    .badge { background: #1f293d; color: #76e4bd; padding: 2px 6px; border-radius: 4px; font-size: 11px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Connect GitHub App</h1>
    <p>Paste the credentials from your GitHub App below. They will be encrypted immediately with AES-GCM into your D1 database.</p>
    <form method="post" action="/setup/manual">
      <label>App ID</label>
      <input type="text" name="appId" placeholder="e.g. 1122334" required>

      <label>Client ID</label>
      <input type="text" name="clientId" placeholder="e.g. Iv1.xxx or Iv23xxx" required>

      <label>Client Secret</label>
      <input type="password" name="clientSecret" placeholder="Paste generated client secret" required>

      <label>Private Key (.pem contents)</label>
      <textarea name="privateKey" placeholder="-----BEGIN RSA PRIVATE KEY-----&#10;...&#10;-----END RSA PRIVATE KEY-----" required></textarea>

      <label>Installation ID <span class="badge">From URL when installed</span></label>
      <input type="text" name="installationId" placeholder="e.g. 66778899" required>

      <button type="submit">Save &amp; Complete Setup</button>
    </form>
  </div>
</body>
</html>`;
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
  }

  // POST: Encrypt credentials into D1
  if (p === "/setup/manual" && req.method === "POST") {
    const form = await req.formData();
    const appId = String(form.get("appId") || "").trim();
    const clientId = String(form.get("clientId") || "").trim();
    const clientSecret = String(form.get("clientSecret") || "").trim();
    const privateKey = String(form.get("privateKey") || "").trim();
    const installationId = String(form.get("installationId") || "").trim();

    if (!appId || !clientId || !clientSecret || !privateKey || !installationId) {
      throw new ApiError(400, "missing_fields", "All fields are required.");
    }

    for (const [type, value] of [
      ["github_client_secret", clientSecret],
      ["github_private_key", privateKey],
    ] as const) {
      const c = await seal(env, type, value);
      await env.DB.prepare(
        "INSERT INTO encrypted_credentials(id,credential_type,key_version,nonce,ciphertext,created_at) VALUES(?,?,?,?,?,?)"
      )
        .bind(c.id, c.credentialType, c.keyVersion, c.nonce, c.ciphertext, c.createdAt)
        .run();
    }

    await env.DB.prepare(
      "UPDATE setup_state SET github_app_id=?,github_client_id=?,github_installation_id=?,status='provider_pending',updated_at=? WHERE id=1"
    )
      .bind(appId, clientId, installationId, Date.now())
      .run();

    return new Response(null, {
      status: 302,
      headers: { location: "/" },
    });
  }

  return null;
}

export async function ownerSetupRoutes(req: Request, env: Env, o: Owner) {
  const p = new URL(req.url).pathname;
  if (p === "/api/setup/readiness" && req.method === "GET") return json(await readiness(env));
  if (p === "/api/setup/reset" && req.method === "POST") {
    const b = (await readJson(req)) as any;
    if (b.confirm !== "RESET" || req.headers.get("x-reauthenticated") !== "true") {
      throw new ApiError(403, "recent_reauthentication_required", "Recent GitHub reauthentication and explicit RESET confirmation are required.");
    }
    await env.DB.prepare(
      "UPDATE setup_state SET github_app_id=NULL,github_client_id=NULL,github_installation_id=NULL,status='github_app_pending',updated_at=? WHERE id=1"
    )
      .bind(Date.now())
      .run();
    await env.DB.prepare(
      "UPDATE encrypted_credentials SET disabled_at=? WHERE credential_type LIKE 'github_%' AND disabled_at IS NULL"
    )
      .bind(Date.now())
      .run();
    return json({ status: "github_app_pending" });
  }
  return null;
}