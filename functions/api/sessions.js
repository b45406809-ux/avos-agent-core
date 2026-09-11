// functions/api/sessions.js
export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const sessionId = url.searchParams.get("id");

  const jsonHeaders = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*"
  };

  try {
    if (!env.DB) {
      return new Response(JSON.stringify({ error: "Missing D1 database binding 'DB'" }), { status: 500, headers: jsonHeaders });
    }

    // 1. Fetch single session details and full message history
    if (sessionId) {
      const session = await env.DB.prepare(`SELECT * FROM sessions WHERE id = ?`).bind(sessionId).first();
      if (!session) {
        return new Response(JSON.stringify({ error: "Session not found" }), { status: 404, headers: jsonHeaders });
      }

      const { results: messages } = await env.DB.prepare(
        `SELECT role, content, timestamp FROM messages WHERE session_id = ? ORDER BY id ASC`
      ).bind(sessionId).all();

      return new Response(JSON.stringify({ session, messages: messages || [] }), { headers: jsonHeaders });
    }

    // 2. Fetch list of recent sessions for the sidebar
    const { results: sessions } = await env.DB.prepare(
      `SELECT id, title, target_repo, target_branch, updated_at FROM sessions ORDER BY updated_at DESC LIMIT 50`
    ).all();

    return new Response(JSON.stringify({ sessions: sessions || [] }), { headers: jsonHeaders });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: jsonHeaders });
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const jsonHeaders = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

  try {
    const { target_repo, target_branch = "main", title, custom_env_json = "{}" } = await request.json();
    const id = `sess_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const now = Date.now();

    await env.DB.prepare(
      `INSERT INTO sessions (id, title, target_repo, target_branch, custom_env_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, title || `Session: ${target_repo}`, target_repo, target_branch, custom_env_json, now, now).run();

    return new Response(JSON.stringify({ id, target_repo, target_branch }), { headers: jsonHeaders });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: jsonHeaders });
  }
}
