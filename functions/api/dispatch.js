// functions/api/dispatch.js
export async function onRequestPost(context) {
  const { request, env } = context;
  const jsonHeaders = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

  try {
    const body = await request.json().catch(() => null);
    if (!body) {
      return new Response(JSON.stringify({ error: "Invalid JSON request body" }), { status: 400, headers: jsonHeaders });
    }

    const {
      session_id,
      target_repo,
      target_branch = "main",
      user_prompt,
      execution_mode = "single",
      max_workers = "4",
      max_budget_tokens = "8000000",
      create_pr = false,
      custom_env_json = "{}",
      ui_secret
    } = body;

    // Security Gatekeeper
    if (ui_secret !== env.AGENT_UI_SECRET) {
      return new Response(JSON.stringify({ error: "Unauthorized: Invalid UI secret passphrase." }), { status: 401, headers: jsonHeaders });
    }

    if (!target_repo || !user_prompt) {
      return new Response(JSON.stringify({ error: "Missing target_repo or user_prompt." }), { status: 400, headers: jsonHeaders });
    }

    const now = Date.now();
    let sessId = session_id;

    // 1. Create session if not already existing
    if (!sessId) {
      sessId = `sess_${now}_${Math.random().toString(36).substring(2, 7)}`;
      const title = user_prompt.slice(0, 40) + (user_prompt.length > 40 ? "..." : "");
      await env.DB.prepare(
        `INSERT INTO sessions (id, title, target_repo, target_branch, custom_env_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(sessId, title, target_repo.trim(), target_branch.trim(), custom_env_json, now, now).run();
    } else {
      await env.DB.prepare(`UPDATE sessions SET updated_at = ? WHERE id = ?`).bind(now, sessId).run();
    }

    // 2. Persist user message into conversation history
    await env.DB.prepare(
      `INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, 'user', ?, ?)`
    ).bind(sessId, user_prompt.trim(), now).run();

    const runId = `run_${now}_${Math.random().toString(36).substring(2, 7)}`;

    // 3. Insert run into D1
    await env.DB.prepare(
      `INSERT INTO runs (id, session_id, target_repo, target_branch, user_prompt, execution_mode, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)`
    ).bind(runId, sessId, target_repo.trim(), target_branch.trim(), user_prompt.trim(), execution_mode, now).run();

    // 4. Trigger GitHub Actions Runner
    const controlRepo = env.CONTROL_REPO || "owner/avos-agent-core";
    const streamUrl = `${new URL(request.url).origin}/api/events`;

    const ghRes = await fetch(`https://api.github.com/repos/${controlRepo}/actions/workflows/agent.yml/dispatches`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.USER_GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "AVOS-ControlPlane",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        ref: "main",
        inputs: {
          target_repo: target_repo.trim(),
          target_branch: target_branch.trim(),
          user_prompt: user_prompt.trim(),
          session_id: sessId,
          execution_mode: String(execution_mode),
          max_workers: String(max_workers),
          max_budget_tokens: String(max_budget_tokens),
          create_pr: String(create_pr),
          ui_secret: String(ui_secret),
          run_id: String(runId),
          cf_stream_url: String(streamUrl),
          custom_env_json: String(custom_env_json)
        }
      })
    });

    if (!ghRes.ok) {
      const err = await ghRes.text();
      await env.DB.prepare(`UPDATE runs SET status = 'failed', summary = ? WHERE id = ?`)
        .bind(`GitHub Dispatch Failed: ${err}`, runId).run();
      return new Response(JSON.stringify({ error: `GitHub API error: ${err}` }), { status: 502, headers: jsonHeaders });
    }

    return new Response(JSON.stringify({ success: true, runId, sessionId: sessId }), { headers: jsonHeaders });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: jsonHeaders });
  }
}
