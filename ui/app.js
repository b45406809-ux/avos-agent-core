/**
 * AVOS Autonomous Swarm Control Plane - Client Controller (ui/app.js)
 *
 * Coordinates edge dispatching to Cloudflare Functions (/api/dispatch),
 * manages live real-time Server-Sent Events (/api/stream), renders colorized
 * telemetry, and maintains client-side persistence in LocalStorage.
 */

// Form input element IDs persisted across reloads
const CONFIG_FIELDS = [
  "gh_pat",
  "control_repo",
  "ui_secret",
  "target_repo",
  "target_branch",
  "execution_mode",
  "max_workers",
  "max_budget_tokens",
  "create_pr",
  "user_prompt"
];

let eventSource = null;
let eventCounter = 0;
let currentActiveRunId = null;

// ============================================================================
// 1. Initialization & State Persistence
// ============================================================================

document.addEventListener("DOMContentLoaded", () => {
  loadSavedPreferences();
  bindFormChangeListeners();
});

/**
 * Loads stored input parameters from LocalStorage into form elements.
 */
function loadSavedPreferences() {
  CONFIG_FIELDS.forEach((fieldId) => {
    const element = document.getElementById(fieldId);
    if (!element) return;

    const savedValue = localStorage.getItem(`avos_${fieldId}`);
    if (savedValue !== null) {
      if (element.tagName === "SELECT") {
        element.value = savedValue;
      } else if (element.type === "checkbox") {
        element.checked = savedValue === "true";
      } else {
        element.value = savedValue;
      }
    }
  });
}

/**
 * Saves all form values to LocalStorage.
 */
function persistPreferences() {
  CONFIG_FIELDS.forEach((fieldId) => {
    const element = document.getElementById(fieldId);
    if (!element) return;

    const value = element.type === "checkbox" ? String(element.checked) : element.value.trim();
    localStorage.setItem(`avos_${fieldId}`, value);
  });
}

function bindFormChangeListeners() {
  CONFIG_FIELDS.forEach((fieldId) => {
    const element = document.getElementById(fieldId);
    if (element) {
      element.addEventListener("input", persistPreferences);
      element.addEventListener("change", persistPreferences);
    }
  });
}

// ============================================================================
// 2. Mission Dispatcher (Cloudflare Function /api/dispatch)
// ============================================================================

/**
 * Dispatches the mission via Cloudflare Edge and connects to real-time SSE stream.
 */
async function dispatchSwarm() {
  persistPreferences();

  const uiSecret = document.getElementById("ui_secret")?.value.trim();
  const targetRepo = document.getElementById("target_repo")?.value.trim();
  const targetBranch = document.getElementById("target_branch")?.value.trim() || "main";
  const executionMode = document.getElementById("execution_mode")?.value || "swarm";
  const maxWorkers = document.getElementById("max_workers")?.value || "4";
  const maxBudgetTokens = document.getElementById("max_budget_tokens")?.value || "8000000";
  const createPr = document.getElementById("create_pr")?.value === "true";
  const prompt = document.getElementById("user_prompt")?.value.trim();

  // Basic Validation
  if (!uiSecret) {
    alert("Please provide the Security Validation Secret matching AGENT_UI_SECRET.");
    return;
  }
  if (!targetRepo || !targetRepo.includes("/")) {
    alert("Please enter a valid Target Repository in the format 'owner/repo'.");
    return;
  }
  if (!prompt) {
    alert("Please enter a Mission Goal or Architectural Task.");
    return;
  }

  const dispatchBtn = document.getElementById("dispatch-btn");
  if (dispatchBtn) dispatchBtn.disabled = true;

  clearTerminal();
  updateStatusBadge("running", "Dispatching to Edge...");
  appendLog("INIT", "OPERATOR", `Initiating mission on ${targetRepo} (${targetBranch}) in [${executionMode.toUpperCase()}] mode...`);

  try {
    // 1. Send dispatch request to Cloudflare Pages Function
    const response = await fetch("/api/dispatch", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        target_repo: targetRepo,
        target_branch: targetBranch,
        user_prompt: prompt,
        execution_mode: executionMode,
        max_workers: maxWorkers,
        max_budget_tokens: maxBudgetTokens,
        create_pr: createPr,
        ui_secret: uiSecret
      })
    });

    const data = await response.json();

    if (!response.ok || data.error) {
      throw new Error(data.error || (data.details ? `${data.error}: ${data.details}` : "Failed to dispatch mission."));
    }

    currentActiveRunId = data.runId;
    updateStatusBadge("running", "Agent Active");
    appendLog("INIT", "EDGE", `Mission registered on Edge SQLite. Run ID: ${data.runId}`);
    appendLog("INIT", "STREAM", "Connecting real-time Server-Sent Events (SSE) telemetry pipe...");

    // 2. Open live Server-Sent Events connection
    connectLiveStream(data.runId);

  } catch (err) {
    appendLog("ERROR", "DISPATCH", err.message);
    updateStatusBadge("failed", "Dispatch Failed");
    if (dispatchBtn) dispatchBtn.disabled = false;
  }
}

window.dispatchSwarm = dispatchSwarm;

// ============================================================================
// 3. Real-Time Server-Sent Events (SSE) Stream Receiver
// ============================================================================

/**
 * Connects to the Cloudflare Functions /api/stream endpoint.
 */
function connectLiveStream(runId) {
  if (eventSource) {
    eventSource.close();
  }

  eventCounter = 0;
  const streamUrl = `/api/stream?runId=${encodeURIComponent(runId)}`;
  eventSource = new EventSource(streamUrl);

  eventSource.onopen = () => {
    updateStatusBadge("running", "Streaming Live");
  };

  eventSource.onmessage = (messageEvent) => {
    try {
      if (!messageEvent.data || messageEvent.data.startsWith(":")) {
        return; // Ignore keep-alive heartbeats
      }

      const eventPayload = JSON.parse(messageEvent.data);
      eventCounter++;

      const counterBadge = document.getElementById("run-counter");
      if (counterBadge) {
        counterBadge.innerText = `${eventCounter} Events Streamed`;
      }

      // Extract high-signal display text from payload
      const eventData = eventPayload.data || {};
      const displayText = 
        eventData.text || 
        eventData.summary || 
        eventData.command || 
        eventData.preview || 
        eventData.error || 
        (eventData.tool ? `tool: ${eventData.tool}` : "") || 
        JSON.stringify(eventData);

      appendLog(eventPayload.type || "INFO", eventPayload.agentId || "SWARM", displayText, eventData);

      // Handle Terminal Events
      if (eventPayload.type === "completed") {
        updateStatusBadge("active", "Completed");
        closeStream();
      } else if (eventPayload.type === "error") {
        updateStatusBadge("failed", "Failed");
        closeStream();
      }
    } catch (parseErr) {
      console.warn("[SSE] Error parsing stream frame:", parseErr);
    }
  };

  eventSource.onerror = (err) => {
    console.log("[SSE] Stream connection closed or transitioning.");
  };
}

function closeStream() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  const dispatchBtn = document.getElementById("dispatch-btn");
  if (dispatchBtn) dispatchBtn.disabled = false;
}

// ============================================================================
// 4. Viewport Terminal & Formatting Helpers
// ============================================================================

/**
 * Appends a color-coded log line to the live terminal viewport.
 */
function appendLog(type, agent, text, rawData = null) {
  const terminal = document.getElementById("terminal");
  if (!terminal) return;

  const row = document.createElement("div");
  row.className = "log-row";

  const timeString = new Date().toLocaleTimeString();
  const normalizedType = (type || "STDOUT").toLowerCase().replace(/[^a-z0-9_]/g, "_");
  const typeCssClass = `tag-${normalizedType}`;

  let contentHtml = `<span>${escapeHtml(text)}</span>`;

  // Render clickable [details] dropdown if payload has rich metadata
  if (rawData && typeof rawData === "object" && Object.keys(rawData).length > 0 && !rawData.text) {
    const metaId = `meta_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    contentHtml += `
      <span class="meta-toggle" onclick="toggleMetaBlock('${metaId}')">[details]</span>
      <pre id="${metaId}" class="meta-block" style="display:none;">${escapeHtml(JSON.stringify(rawData, null, 2))}</pre>
    `;
  }

  row.innerHTML = `
    <span class="log-time">[${timeString}]</span>
    <span class="log-tag ${typeCssClass}">[${escapeHtml(agent)}] [${escapeHtml(type.toUpperCase())}]</span>
    ${contentHtml}
  `;

  terminal.appendChild(row);

  // Auto-scroll terminal viewport to bottom
  terminal.scrollTop = terminal.scrollHeight;
}

/**
 * Toggles visibility of metadata inspector blocks.
 */
function toggleMetaBlock(blockId) {
  const block = document.getElementById(blockId);
  if (block) {
    block.style.display = block.style.display === "none" ? "block" : "none";
  }
}
window.toggleMetaBlock = toggleMetaBlock;

function clearTerminal() {
  const terminal = document.getElementById("terminal");
  if (terminal) {
    terminal.innerHTML = "";
  }
}
window.clearTerminal = clearTerminal;

function updateStatusBadge(statusClass, text) {
  const badge = document.getElementById("status-badge");
  if (!badge) return;

  badge.className = `badge ${statusClass}`.trim();
  badge.innerText = text;
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
