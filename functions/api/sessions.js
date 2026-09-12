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

    if (sessionId) {
      const session = await env.DB.prepare(`SELECT * FROM sessions WHERE id = ?`).bind(sessionId).first();
      if (!session) {
        return new Response(JSON.stringify({ error: "Session not found" }), { status: 404, headers: jsonHeaders });
      }

      const { results: messages } = await env.DB.prepare(
        `SELECT role, type, content, timestamp FROM messages WHERE session_id = ? ORDER BY id ASC`
      ).bind(sessionId).all();

      const { results: events } = await env.DB.prepare(
        `SELECT id, run_id, timestamp, type, agent_id, payload_json
         FROM events
         WHERE session_id = ?
         ORDER BY id ASC`
      ).bind(sessionId).all();

      const latestRun = await env.DB.prepare(
        `SELECT id, status, summary, created_at, finished_at FROM runs WHERE session_id = ? ORDER BY created_at DESC LIMIT 1`
      ).bind(sessionId).first();

      return new Response(JSON.stringify({
        session,
        messages: messages || [],
        events: events || [],
        latestRun: latestRun || null
      }), { headers: jsonHeaders });
    }

    const { results: sessions } = await env.DB.prepare(
      `SELECT id, title, target_repo, target_branch, updated_at FROM sessions ORDER BY updated_at DESC LIMIT 50`
    ).all();

    return new Response(JSON.stringify({ sessions: sessions || [] }), { headers: jsonHeaders });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: jsonHeaders });
  }
}
