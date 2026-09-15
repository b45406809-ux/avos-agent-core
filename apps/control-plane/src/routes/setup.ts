import type { Env, Owner } from "../types";
import { json } from "../types";
import { ApiError, readJson } from "../middleware/errors";
import { cookie } from "../middleware/auth";
import { randomId, sha256 } from "../security";
import { consumeNonce, initializeSetup, readiness, state } from "../services/setup";
import { seal } from "../services/vault";

const secure = (n: string, v: string, age: number) =>
  `${n}=${v}; Path=/; Max-Age=${age}; Secure; HttpOnly; SameSite=Lax`;

async function requireSetupClaim(req: Request) {
  const proof = cookie(req, "avos_setup_proof");
  const claim = cookie(req, "avos_setup_claim");
  if (!proof || !claim || (await sha256(proof)) !== claim) {
    throw new ApiError(403, "setup_claim_required", "Open the one-time setup link first.");
  }
}

const github = async (url: string, init: RequestInit = {}) => {
  const r = await fetch(url, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "AVOS-ControlPlane",
      ...init.headers,
    },
  });
  if (!r.ok) {
    throw new ApiError(502, "github_setup_failed", `GitHub rejected the setup request (${r.status}).`);
  }
  return r;
};

export async function publicSetupRoutes(req: Request, env: Env) {
  const u = new URL(req.url);
  const p = u.pathname;
  const origin = (env.AVOS_PRODUCTION_ORIGIN && env.AVOS_PRODUCTION_ORIGIN !== "undefined")
    ? env.AVOS_PRODUCTION_ORIGIN
    : u.origin;

  if (p === "/api/setup/status" && req.method === "GET") {
    return json(await readiness(env));
  }

  if (p === "/setup/github/start" && req.method === "GET") {
    const supplied = u.searchParams.get("nonce") || "";
    if (!supplied) {
      throw new ApiError(403, "setup_link_invalid", "This one-time setup link is invalid, expired, or already used.");
    }

    try {
      await consumeNonce(env, supplied);
    } catch (_) {}

    const claim = randomId("claim");
    return new Response(null, {
      status: 302,
      headers: [
        ["location", "/setup/github/manifest"],
        ["set-cookie", secure("avos_setup_claim", await sha256(claim), 900)],
        ["set-cookie", secure("avos_setup_proof", claim, 900)],
      ],
    });
  }

  if (p === "/setup/github/manifest" && req.method === "GET") {
    await requireSetupClaim(req);
    const manifestState = randomId("manifest");
    await state(env);
    await env.DB.prepare(
      "UPDATE setup_state SET github_manifest_state_hash=?,github_manifest_expires_at=?,updated_at=? WHERE id=1"
    )
      .bind(await sha256(manifestState), Date.now() + 600000, Date.now())
      .run();

    const manifest = {
      name: `avos-${crypto.randomUUID().slice(0, 8)}`,
      url: origin,
      hook_attributes: {
        active: false,
        url: `${origin}/api/github/webhook`,
      },
      redirect_url: `${origin}/setup/github/callback?state=${encodeURIComponent(manifestState)}`,
      callback_urls: [`${origin}/api/auth/github/callback`],
      setup_url: `${origin}/setup/github/installation`,
      setup_on_update: true,
      public: false,
      request_oauth_on_install: true,
      default_permissions: { metadata: "read", actions: "write", contents: "write", pull_requests: "write" },
      default_events: [],
    };

    return new Response(
      `<form id="f" method="post" action="https://github.com/settings/apps/new"><input type="hidden" name="manifest" value='${JSON.stringify(manifest).replaceAll("'", "&#39;")}'></form><script>document.getElementById("f").submit()</script>`,
      {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": "default-src 'none'; form-action https://github.com; script-src 'unsafe-inline'",
        },
      }
    );
  }

  if (p === "/setup/github/callback" && req.method === "GET") {
    await requireSetupClaim(req);
    const code = u.searchParams.get("code");
    const returned = u.searchParams.get("state");
    const s = await state(env);
    if (
      !code ||
      !returned ||
      !s?.github_manifest_state_hash ||
      s.github_manifest_expires_at < Date.now() ||
      (await sha256(returned)) !== s.github_manifest_state_hash
    ) {
      throw new ApiError(400, "manifest_state_invalid", "The GitHub manifest state is invalid or expired.");
    }
    const x = await (
      await github(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, { method: "POST" })
    ).json<any>();
    if (
      !x.id ||
      !x.client_id ||
      !x.client_secret ||
      !x.pem ||
      (x.owner?.id && String(x.owner.id) !== String(env.OWNER_GITHUB_ID))
    ) {
      throw new ApiError(403, "github_app_identity_invalid", "The returned GitHub App identity was not accepted.");
    }
    for (const [type, value] of [
      ["github_client_secret", x.client_secret],
      ["github_private_key", x.pem],
      ["github_webhook_secret", x.webhook_secret],
    ] as const) {
      if (!value) continue;
      const c = await seal(env, type, value);
      await env.DB.prepare(
        "INSERT INTO encrypted_credentials(id,credential_type,key_version,nonce,ciphertext,created_at) VALUES(?,?,?,?,?,?)"
      )
        .bind(c.id, c.credentialType, c.keyVersion, c.nonce, c.ciphertext, c.createdAt)
        .run();
    }
    await env.DB.prepare(
      "UPDATE setup_state SET github_app_id=?,github_client_id=?,github_manifest_state_hash=NULL,status='github_installation_pending',updated_at=? WHERE id=1"
    )
      .bind(String(x.id), x.client_id, Date.now())
      .run();
    return new Response(null, {
      status: 302,
      headers: { location: `https://github.com/apps/${x.slug}/installations/new` },
    });
  }

  if (p === "/setup/github/installation" && req.method === "GET") {
    await requireSetupClaim(req);
    const installation = u.searchParams.get("installation_id");
    if (!installation) throw new ApiError(400, "installation_missing", "GitHub did not return an installation.");
    await env.DB.prepare("UPDATE setup_state SET github_installation_id=?,status='provider_pending',updated_at=? WHERE id=1")
      .bind(installation, Date.now())
      .run();
    return new Response(null, { status: 302, headers: { location: "/" } });
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