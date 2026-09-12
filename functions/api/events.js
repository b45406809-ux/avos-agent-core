// functions/api/events.js
export async function onRequestPost(context) {
  const { request, env } = context;
  const jsonHeaders = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

  try {
    const authHeader = request.headers.get("Authorization") || "";
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();

    if (!token || token !== env.AGENT_UI_SECRET) {
      return new Response(JSON.stringify({ error: "Unauthorized emitter" }), { status: 401, headers: jsonHeaders });
    }

    const body = await request.json().catch(() => null);
    if (!body || !body.runId) {
      return new Response(JSON.stringify({ error: "Missing runId" }), { status: 400, headers: jsonHeaders });
    }

    const { runId } = body;
    const rawEvents = Array.isArray(body.events) ? body.events : (body.event ? [body.event] : []);
    if (rawEvents.length === 0) {
      return new Response(JSON.stringify({ ok: true, processed: 0 }), { status: 200, headers: jsonHeaders });
    }

    const runRecord = await env.DB.prepare(`SELECT session_id FROM runs WHERE id = ?`).bind(runId).first();
    const sessionId = runRecord?.session_id || null;

    const statements = [];
    const now = Date.now();

    for (const ev of rawEvents) {
      const timestamp = ev.timestamp || now;
      const type = ev.type || "unknown";
      const agentId = ev.agentId || "AGENT";
      const payloadObj = ev.data || {};
      const payloadJson = JSON.stringify(payloadObj);

      statements.push(
        env.DB.prepare(
          `INSERT INTO events (run_id, session_id, timestamp, type, agent_id, payload_json)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).bind(runId, sessionId, timestamp, type, agentId, payloadJson)
      );

      if (type === "completed") {
        statements.push(
          env.DB.prepare(`UPDATE runs SET status = 'completed', finished_at = ?, summary = ? WHERE id = ?`)
            .bind(timestamp, payloadObj.summary || "Task completed.", runId)
        );
        if (sessionId) {
          statements.push(
            env.DB.prepare(`INSERT INTO messages (session_id, run_id, role, type, content, timestamp) VALUES (?, ?, 'assistant', 'final', ?, ?)`)
              .bind(sessionId, runId, payloadObj.summary || "Task completed successfully.", timestamp)
          );
        }
      } else if (type === "error") {
        statements.push(
          env.DB.prepare(`UPDATE runs SET status = 'failed', finished_at = ?, summary = ? WHERE id = ?`)
            .bind(timestamp, payloadObj.error || payloadObj.message || "Failed.", runId)
        );
        if (sessionId) {
          statements.push(
            env.DB.prepare(`INSERT INTO messages (session_id, run_id, role, type, content, timestamp) VALUES (?, ?, 'assistant', 'error', ?, ?)`)
              .bind(sessionId, runId, `❌ Error: ${payloadObj.error || payloadObj.message || "Execution failed."}`, timestamp)
          );
        }
      }
    }

    if (statements.length > 0) {
      await env.DB.batch(statements);
    }

    return new Response(JSON.stringify({ ok: true, processed: rawEvents.length }), { status: 200, headers: jsonHeaders });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: jsonHeaders });
  }
}
