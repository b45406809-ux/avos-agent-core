/**
 * Cloudflare Pages Function: POST /api/events
 * 
 * Ingestion endpoint called by the GitHub Actions runner (via engine/logger.mjs).
 * Validates authentication, records real-time telemetry into Cloudflare D1 (SQLite),
 * updates task DAG states, and powers live Server-Sent Events (SSE) streaming.
 */

export async function onRequestPost(context) {
  const { request, env } = context;

  const jsonHeaders = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
  };

  try {
    // 1. Verify Authorization Header (Bearer Secret)
    const authHeader = request.headers.get("Authorization") || "";
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();

    if (!token || token !== env.AGENT_UI_SECRET) {
      return new Response(
        JSON.stringify({ error: "Unauthorized: Invalid or missing stream emitter token." }),
        { status: 401, headers: jsonHeaders }
      );
    }

    // 2. Parse Incoming Payload
    const body = await request.json().catch(() => null);
    if (!body || !body.runId) {
      return new Response(
        JSON.stringify({ error: "Invalid payload: 'runId' is required." }),
        { status: 400, headers: jsonHeaders }
      );
    }

    if (!env.DB) {
      return new Response(
        JSON.stringify({ error: "Server Configuration Error: D1 database binding 'DB' is missing." }),
        { status: 500, headers: jsonHeaders }
      );
    }

    const { runId } = body;
    
    // Normalize single event or batch of events into an array
    const rawEvents = Array.isArray(body.events) 
      ? body.events 
      : body.event 
        ? [body.event] 
        : [];

    if (rawEvents.length === 0) {
      return new Response(
        JSON.stringify({ error: "No events provided in payload." }),
        { status: 400, headers: jsonHeaders }
      );
    }

    const insertStatements = [];
    const now = Date.now();

    for (const ev of rawEvents) {
      const timestamp = ev.timestamp || now;
      const type = ev.type || "unknown";
      const agentId = ev.agentId || "AGENT";
      const payloadObj = ev.data || {};
      const payloadJson = JSON.stringify(payloadObj);

      // 1. Queue Event Insertion
      insertStatements.push(
        env.DB.prepare(
          `INSERT INTO events (run_id, timestamp, type, agent_id, payload_json)
           VALUES (?, ?, ?, ?, ?)`
        ).bind(runId, timestamp, type, agentId, payloadJson)
      );

      // 2. Handle State Transitions on the Master Run Record
      if (type === "init") {
        insertStatements.push(
          env.DB.prepare(
            `UPDATE runs SET status = 'in_progress' WHERE id = ? AND status = 'queued'`
          ).bind(runId)
        );
      } else if (type === "completed") {
        insertStatements.push(
          env.DB.prepare(
            `UPDATE runs 
             SET status = 'completed', finished_at = ?, summary = ? 
             WHERE id = ?`
          ).bind(timestamp, payloadObj.summary || "Mission completed successfully.", runId)
        );
      } else if (type === "error") {
        insertStatements.push(
          env.DB.prepare(
            `UPDATE runs 
             SET status = 'failed', finished_at = ?, summary = ? 
             WHERE id = ?`
          ).bind(timestamp, payloadObj.error || payloadObj.message || "Run encountered fatal error.", runId)
        );
      } else if (type === "token_ledger") {
        insertStatements.push(
          env.DB.prepare(
            `UPDATE runs SET token_usage_json = ? WHERE id = ?`
          ).bind(payloadJson, runId)
        );
      }

      // 3. Handle Stigmergic Field Guide Updates
      if (type === "field_guide_initialized" || type === "field_guide_updated") {
        insertStatements.push(
          env.DB.prepare(
            `INSERT INTO field_guides (run_id, detected_stack, test_command, content_md, contracts_json, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(run_id) DO UPDATE SET
               detected_stack = excluded.detected_stack,
               test_command = excluded.test_command,
               content_md = excluded.content_md,
               contracts_json = excluded.contracts_json,
               updated_at = excluded.updated_at`
          ).bind(
            runId,
            payloadObj.stack || "Polyglot",
            payloadObj.oracle || "",
            payloadObj.contentMd || "",
            JSON.stringify(payloadObj.contracts || {}),
            timestamp
          )
        );
      }

      // 4. Handle Task DAG Decomposition Ledger
      if (type === "dag_generated" && Array.isArray(payloadObj.tasks)) {
        for (const task of payloadObj.tasks) {
          insertStatements.push(
            env.DB.prepare(
              `INSERT INTO task_states (run_id, task_id, description, files_targeted_json, dependencies_json, verification_command, status, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?)
               ON CONFLICT(run_id, task_id) DO UPDATE SET
                 description = excluded.description,
                 files_targeted_json = excluded.files_targeted_json,
                 dependencies_json = excluded.dependencies_json,
                 verification_command = excluded.verification_command,
                 updated_at = excluded.updated_at`
            ).bind(
              runId,
              task.id,
              task.description,
              JSON.stringify(task.filesTargeted || []),
              JSON.stringify(task.dependencies || []),
              task.verificationCommand || "",
              timestamp
            )
          );
        }
      }

      // 5. Handle Granular Task Status Updates
      if (type === "test_passed" && payloadObj.taskId) {
        insertStatements.push(
          env.DB.prepare(
            `UPDATE task_states SET status = 'VERIFIED', updated_at = ? WHERE run_id = ? AND task_id = ?`
          ).bind(timestamp, runId, payloadObj.taskId)
        );
      } else if (type === "self_healing" && payloadObj.taskId) {
        insertStatements.push(
          env.DB.prepare(
            `UPDATE task_states SET status = 'IN_PROGRESS', summary = ?, updated_at = ? WHERE run_id = ? AND task_id = ?`
          ).bind(`Self-healing retry: ${payloadObj.error || ""}`.slice(0, 500), timestamp, runId, payloadObj.taskId)
        );
      }
    }

    // Execute all database updates in a single atomic batch
    if (insertStatements.length > 0) {
      await env.DB.batch(insertStatements);
    }

    return new Response(
      JSON.stringify({ ok: true, processed: rawEvents.length, runId }),
      { status: 200, headers: jsonHeaders }
    );

  } catch (err) {
    return new Response(
      JSON.stringify({ error: "Internal Edge Event Ingestion Exception", message: err.message }),
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
