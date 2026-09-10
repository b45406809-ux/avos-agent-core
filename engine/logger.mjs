import * as fs from "fs";
import * as path from "path";

/**
 * SwarmLogger manages multi-destination real-time telemetry:
 * 1. Local JSONL file stream (.agent/live_stream.jsonl) for CI artifact archival.
 * 2. Real-time async HTTP event batching to Cloudflare Edge (/api/events) for live dashboard streaming.
 * 3. Colorized terminal console output for developer and workflow logs.
 */
export class SwarmLogger {
  constructor(agentDir = "./.agent") {
    this.agentDir = path.resolve(agentDir);
    this.streamFile = path.join(this.agentDir, "live_stream.jsonl");

    // Cloudflare Edge stream parameters
    this.cfStreamUrl = process.env.CF_STREAM_URL || null;
    this.cfSecret = process.env.AGENT_UI_SECRET || null;
    this.runId = process.env.RUN_ID || null;

    // HTTP Event Batching Queue (Non-blocking)
    this.httpQueue = [];
    this.isFlushing = false;
    this.flushIntervalMs = 400; // Batch dispatch every 400ms

    this.initStorage();
    this.startBatchTimer();
  }

  /**
   * Initializes local storage directory and live_stream.jsonl file.
   */
  initStorage() {
    try {
      fs.mkdirSync(this.agentDir, { recursive: true });
      fs.writeFileSync(this.streamFile, "", "utf-8");
    } catch (err) {
      console.error(`[SwarmLogger] Failed to initialize agent directory: ${err.message}`);
    }
  }

  /**
   * Starts background timer to flush batched HTTP events to Cloudflare D1.
   */
  startBatchTimer() {
    if (this.cfStreamUrl && this.runId && this.cfSecret) {
      this.batchInterval = setInterval(() => {
        if (this.httpQueue.length > 0 && !this.isFlushing) {
          this.flushHttpQueue();
        }
      }, this.flushIntervalMs);

      // Ensure timer doesn't prevent Node.js process from exiting
      if (this.batchInterval.unref) {
        this.batchInterval.unref();
      }
    }
  }

  /**
   * Emits a telemetry event across all destinations (Local JSONL, Console, and Cloudflare Edge).
   *
   * @param {string} type - Event category (e.g., 'init', 'thought', 'tool_start', 'test_verify', 'completed')
   * @param {string} agentId - Actor emitting the event (e.g., 'ORCHESTRATOR', 'PLANNER', 'WORKER-1', 'REFEREE')
   * @param {object} [payload={}] - Detailed event data
   */
  emit(type, agentId, payload = {}) {
    const entry = {
      timestamp: Date.now(),
      type: type.toLowerCase(),
      agentId: agentId.toUpperCase(),
      data: payload
    };

    // 1. Write to local JSONL for workflow artifact retention
    this.writeLocalJsonl(entry);

    // 2. Format and print to runner stdout
    this.printToConsole(entry);

    // 3. Queue for async HTTP delivery to Cloudflare Pages Functions
    if (this.cfStreamUrl && this.runId && this.cfSecret) {
      this.httpQueue.push(entry);

      // Immediately flush on terminal milestone events
      if (["completed", "error", "init", "dag_generated"].includes(entry.type)) {
        this.flushHttpQueue();
      }
    }
  }

  /**
   * Appends an atomic JSON line to the local telemetry stream file.
   */
  writeLocalJsonl(entry) {
    try {
      fs.appendFileSync(this.streamFile, JSON.stringify(entry) + "\n", "utf-8");
    } catch (err) {
      console.error(`[SwarmLogger] Failed writing to ${this.streamFile}: ${err.message}`);
    }
  }

  /**
   * Prints formatted and colorized messages to stdout for GitHub Actions logs.
   */
  printToConsole(entry) {
    const { type, agentId, data } = entry;

    // ANSI Color Palettes
    const colors = {
      reset: "\x1b[0m",
      bold: "\x1b[1m",
      cyan: "\x1b[36m",
      yellow: "\x1b[33m",
      green: "\x1b[32m",
      magenta: "\x1b[35m",
      red: "\x1b[31m",
      blue: "\x1b[34m",
      dim: "\x1b[2m"
    };

    let tagColor = colors.cyan;
    if (type.includes("tool")) tagColor = colors.yellow;
    if (type.includes("test") || type.includes("verify")) tagColor = colors.magenta;
    if (type === "test_passed" || type === "completed" || type === "branch_merged") tagColor = colors.green;
    if (type === "self_healing" || type === "error") tagColor = colors.red;

    const prefix = `[STREAM:${type.toUpperCase()}] [${agentId}]`;
    const summary = data.text || data.summary || data.command || data.preview || data.error || (data.tool ? `tool: ${data.tool}` : "");
    const detailStr = summary ? ` ${summary}` : "";

    console.log(`${tagColor}${colors.bold}${prefix}${colors.reset}${detailStr}`);
  }

  /**
   * Asynchronously posts queued events in a single batch to Cloudflare's /api/events endpoint.
   */
  async flushHttpQueue() {
    if (this.httpQueue.length === 0 || this.isFlushing) return;

    this.isFlushing = true;
    const batch = [...this.httpQueue];
    this.httpQueue = [];

    try {
      const res = await fetch(this.cfStreamUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.cfSecret}`
        },
        body: JSON.stringify({
          runId: this.runId,
          events: batch
        })
      });

      if (!res.ok) {
        console.warn(`[SwarmLogger] HTTP post to Cloudflare returned status ${res.status}`);
      }
    } catch (err) {
      // Re-queue events on transient network drop so they aren't lost
      this.httpQueue.unshift(...batch);
      console.warn(`[SwarmLogger] Network error posting to Cloudflare Edge: ${err.message}`);
    } finally {
      this.isFlushing = false;
    }
  }

  /**
   * Synchronous final flush on process shutdown to ensure terminal events reach Cloudflare.
   */
  async flushAndClose() {
    if (this.batchInterval) {
      clearInterval(this.batchInterval);
    }
    await this.flushHttpQueue();
  }
  }
