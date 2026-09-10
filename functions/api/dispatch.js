/**
 * Cloudflare Pages Function: POST /api/dispatch
 * 
 * Handles zero-trust authorization, initializes the run record in Cloudflare D1 (SQLite),
 * and triggers the GitHub Actions autonomous swarm runner via the GitHub REST API.
 */

export async function onRequestPost(context) {
  const { request, env } = context;

  // Set standard JSON headers
  const jsonHeaders = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
  };

  try {
    // 1. Parse incoming payload
    const body = await request.json().catch(() => null);
    if (!body) {
      return new Response(JSON.stringify({ error: "Invalid JSON request body" }), {
        status: 400,
        headers: jsonHeaders
      });
    }

    const {
      target_repo,
      target_branch = "main",
      user_prompt,
      execution_mode = "swarm",
      max_workers = "4",
      max_budget_tokens = "8000000",
      create_pr = true,
      ui_secret
    } = body;

    // 2. Validate Zero-Trust Authentication Token
    if (!ui_secret || ui_secret !== env.AGENT_UI_SECRET) {
      return new Response(
        JSON.stringify({ error: "Unauthorized: Invalid or missing security validation token." }),
        { status: 401, headers: jsonHeaders }
      );
    }

    // 3. Validate Mandatory Input Fields
    if (!target_repo || !target_repo.includes("/")) {
      return new Response(
        JSON.stringify({ error: "Invalid target_repo format. Must be 'owner/repository'." }),
        { status: 400, headers: jsonHeaders }
      );
    }

    if (!user_prompt || user_prompt.trim().length === 0) {
      return new Response(
        JSON.stringify({ error: "Mission prompt/goal is required and cannot be empty." }),
        { status: 400, headers: jsonHeaders }
      );
    }

    // 4. Verify Cloudflare Environment Bindings
    if (!env.DB) {
      return new Response(
        JSON.stringify({ error: "Server Configuration Error: D1 database binding 'DB' is missing." }),
        { status: 500, headers: jsonHeaders }
      );
    }

    if (!env.USER_GITHUB_TOKEN) {
      return new Response(
        JSON.stringify({ error: "Server Configuration Error: Secret 'USER_GITHUB_TOKEN' is not configured in Cloudflare." }),
        { status: 500, headers: jsonHeaders }
      );
    }

    // 5. Generate Unique Mission Run ID
    const runId = `run_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
    const now = Date.now();

    // 6. Record Initial Mission State in Cloudflare D1 (Edge SQLite)
    await env.DB.prepare(
      `INSERT INTO runs (
        id, 
        target_repo, 
        target_branch, 
        user_prompt, 
        execution_mode, 
        status, 
        created_at
      ) VALUES (?, ?, ?, ?, ?, 'queued', ?)`
    ).bind(
      runId,
      target_repo.trim(),
      target_branch.trim(),
      user_prompt.trim(),
      execution_mode,
      now
    ).run();

    // 7. Compute the Dynamic Edge Event Ingestion Endpoint
    const requestUrl = new URL(request.url);
    const streamCallbackUrl = `${requestUrl.origin}/api/events`;
    const controlRepo = env.CONTROL_REPO || "owner/avos-agent-core";

    // 8. Dispatch GitHub Actions Runner Workflow
    const ghResponse = await fetch(
      `https://api.github.com/repos/${controlRepo}/actions/workflows/agent.yml/dispatches`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.USER_GITHUB_TOKEN}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "AVOS-Cloudflare-ControlPlane",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          ref: "main",
          inputs: {
            target_repo: target_repo.trim(),
            target_branch: target_branch.trim(),
            user_prompt: user_prompt.trim(),
            execution_mode,
            max_workers: String(max_workers),
            max_budget_tokens: String(max_budget_tokens),
            create_pr: Boolean(create_pr),
            ui_secret,
            run_id: runId,
            cf_stream_url: streamCallbackUrl
          }
        })
      }
    );

    // 9. Handle Dispatch Errors from GitHub API
    if (!ghResponse.ok) {
      const errBody = await ghResponse.text();

      // Update D1 run status to failed
      await env.DB.prepare(
        `UPDATE runs SET status = 'failed', summary = ? WHERE id = ?`
      ).bind(`GitHub Dispatch Failed (${ghResponse.status}): ${errBody}`, runId).run();

      return new Response(
        JSON.stringify({ 
          error: `GitHub Dispatch Failed (${ghResponse.status})`, 
          details: errBody,
          controlRepo 
        }),
        { status: 502, headers: jsonHeaders }
      );
    }

    // 10. Return Successful Mission Ticket
    return new Response(
      JSON.stringify({
        success: true,
        runId,
        status: "queued",
        targetRepo: target_repo.trim(),
        branch: target_branch.trim(),
        streamUrl: `/api/stream?runId=${encodeURIComponent(runId)}`
      }),
      { status: 200, headers: jsonHeaders }
    );

  } catch (err) {
    return new Response(
      JSON.stringify({ error: "Internal Edge Dispatch Exception", message: err.message }),
      { status: 500, headers: jsonHeaders }
    );
  }
}

/**
 * Handle CORS Preflight Requests
 */
export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Max-Age": "86400"
    }
  });
  }
