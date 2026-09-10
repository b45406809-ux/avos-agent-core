/**
 * Cloudflare Pages Function: GET /api/stream
 *
 * Real-time Server-Sent Events (SSE) streaming endpoint.
 * Pipes live execution telemetry, worker thoughts, tool calls, and test verification
 * states from Cloudflare D1 (Edge SQLite) directly into the operator dashboard (ui/app.js).
 */

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Last-Event-ID",
    "Access-Control-Allow-Methods": "GET, OPTIONS"
  };

  const runId = url.searchParams.get("runId");
  if (!runId) {
    return new Response(JSON.stringify({ error: "Missing required query parameter: 'runId'." }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...corsHeaders }
    });
  }

  if (!env.DB) {
    return new Response(JSON.stringify({ error: "Server Configuration Error: D1 binding 'DB' is missing." }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders }
    });
  }

  // Support reconnection offset via query param or standard Last-Event-ID header
  const initialFromId = parseInt(
    url.searchParams.get("fromId") || request.headers.get("Last-Event-ID") || "0",
    10
  );

  // Set up Server-Sent Events (SSE) pipe
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  // Background streaming pump reading from D1 at the edge
  (async () => {
    let lastSeqId = isNaN(initialFromId) ? 0 : initialFromId;
    let isActive = true;
    let consecutiveIdleCycles = 0;
    const maxIdleCyclesAfterTerminal = 3; // Flush remaining rows before closing

    try {
      while (isActive) {
        // Check if browser closed connection or tab
        if (request.signal.aborted) {
          isActive = false;
          break;
        }

        // 1. Fetch pending batch of events from D1
        const queryRes = await env.DB.prepare(
          `SELECT id, timestamp, type, agent_id, payload_json 
           FROM events 
           WHERE run_id = ? AND id > ? 
           ORDER BY id ASC 
           LIMIT 100`
        ).bind(runId, lastSeqId).all();

        const rows = queryRes.results || [];

        if (rows.length > 0) {
          consecutiveIdleCycles = 0;

          for (const row of rows) {
            lastSeqId = row.id;

            let parsedPayload = {};
            try {
              parsedPayload = JSON.parse(row.payload_json);
            } catch {
              parsedPayload = { raw: row.payload_json };
            }

            const sseEvent = {
              id: row.id,
              timestamp: row.timestamp,
              type: row.type,
              agentId: row.agent_id,
              data: parsedPayload
            };

            // Format standard SSE frame
            const payloadString = `id: ${row.id}\nevent: message\ndata: ${JSON.stringify(sseEvent)}\n\n`;
            await writer.write(encoder.encode(payloadString));

            // If terminal event encountered, mark run complete
            if (row.type === "completed" || row.type === "error") {
              isActive = false;
              break;
            }
          }
        } else {
          consecutiveIdleCycles++;

          // Send SSE keep-alive comment every cycle to prevent proxy timeouts
          await writer.write(encoder.encode(`: keep-alive ${Date.now()}\n\n`));

          // 2. Check if the master run reached a terminal state in D1
          const runRecord = await env.DB.prepare(
            `SELECT status, summary FROM runs WHERE id = ?`
          ).bind(runId).first();

          if (runRecord) {
            if (runRecord.status === "completed" || runRecord.status === "failed") {
              // Allow a few idle cycles to drain any late events, then terminate stream
              if (consecutiveIdleCycles >= maxIdleCyclesAfterTerminal) {
                const terminalPayload = {
                  type: runRecord.status === "completed" ? "completed" : "error",
                  agentId: "ORCHESTRATOR",
                  data: {
                    summary: runRecord.summary || `Run terminated with status: ${runRecord.status}`
                  }
                };
                await writer.write(encoder.encode(`event: message\ndata: ${JSON.stringify(terminalPayload)}\n\n`));
                isActive = false;
              }
            }
          }
        }

        // Poll cadence: 800ms between batches
        if (isActive) {
          await new Promise(resolve => setTimeout(resolve, 800));
        }
      }
    } catch (err) {
      // Clean error emit if stream is still open
      try {
        const errorEvent = `event: message\ndata: ${JSON.stringify({ type: "error", agentId: "STREAM_PUMP", data: { error: err.message } })}\n\n`;
        await writer.write(encoder.encode(errorEvent));
      } catch (_) {}
    } finally {
      try {
        await writer.close();
      } catch (_) {}
    }
  })();

  return new Response(readable, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no", // Disable buffering on intermediate proxies
      ...corsHeaders
    }
  });
}

/**
 * Handle CORS Preflight Requests
 */
export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Last-Event-ID",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Max-Age": "86400"
    }
  });
                  }
