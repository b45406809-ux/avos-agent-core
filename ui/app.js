/**
 * AVOS Autonomous Swarm Control Plane - Client Controller
 */

// Tracked configuration fields persisted in LocalStorage
const CONFIG_KEYS = [
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

let pollingTimer = null;
let pollCounter = 0;
let currentActiveRunId = null;
let processedLogBytes = 0;

// Initialize on DOM ready
document.addEventListener("DOMContentLoaded", () => {
  loadSavedState();
  setupEventListeners();
});

/**
 * Restore user inputs from LocalStorage
 */
function loadSavedState() {
  CONFIG_KEYS.forEach((key) => {
    const el = document.getElementById(key);
    if (!el) return;
    const saved = localStorage.getItem(`avos_${key}`);
    if (saved !== null) {
      if (el.type === "checkbox") {
        el.checked = saved === "true";
      } else {
        el.value = saved;
      }
    }
  });
}

/**
 * Persist current inputs to LocalStorage
 */
function saveState() {
  CONFIG_KEYS.forEach((key) => {
    const el = document.getElementById(key);
    if (!el) return;
    const val = el.type === "checkbox" ? String(el.checked) : el.value.trim();
    localStorage.setItem(`avos_${key}`, val);
  });
}

function setupEventListeners() {
  CONFIG_KEYS.forEach((key) => {
    const el = document.getElementById(key);
    if (el) {
      el.addEventListener("change", saveState);
      el.addEventListener("input", saveState);
    }
  });
}

/**
 * UI Log Viewport Rendering
 */
function appendLog(type, agent, text, rawData = null) {
  const terminal = document.getElementById("terminal");
  if (!terminal) return;

  const row = document.createElement("div");
  row.className = "log-row";

  const time = new Date().toLocaleTimeString();
  const cleanType = (type || "STDOUT").toLowerCase();
  const typeClass = `tag-${cleanType}`;

  let contentHtml = `<span>${escapeHtml(text)}</span>`;

  // Render collapsible JSON metadata if attached
  if (rawData && typeof rawData === "object" && Object.keys(rawData).length > 0) {
    const rawId = `meta_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    contentHtml += `
      <span class="meta-toggle" onclick="toggleMeta('${rawId}')">[details]</span>
      <pre id="${rawId}" class="meta-block" style="display:none;">${escapeHtml(JSON.stringify(rawData, null, 2))}</pre>
    `;
  }

  row.innerHTML = `
    <span class="log-time">[${time}]</span>
    <span class="log-tag ${typeClass}">[${escapeHtml(agent)}] [${escapeHtml(type.toUpperCase())}]</span>
    ${contentHtml}
  `;

  terminal.appendChild(row);
  terminal.scrollTop = terminal.scrollHeight;
}

function clearTerminal() {
  const terminal = document.getElementById("terminal");
  if (terminal) terminal.innerHTML = "";
  processedLogBytes = 0;
}

window.clearTerminal = clearTerminal;

function toggleMeta(id) {
  const el = document.getElementById(id);
  if (el) {
    el.style.display = el.style.display === "none" ? "block" : "none";
  }
}
window.toggleMeta = toggleMeta;

function setBadge(statusClass, label) {
  const badge = document.getElementById("status-badge");
  if (!badge) return;
  badge.className = `badge ${statusClass}`;
  badge.innerText = label;
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Dispatch Workflow to GitHub Actions
 */
async function dispatchSwarm() {
  saveState();

  const pat = document.getElementById("gh_pat")?.value.trim();
  const controlRepo = document.getElementById("control_repo")?.value.trim();
  const uiSecret = document.getElementById("ui_secret")?.value.trim();
  const targetRepo = document.getElementById("target_repo")?.value.trim();
  const targetBranch = document.getElementById("target_branch")?.value.trim() || "main";
  const mode = document.getElementById("execution_mode")?.value || "swarm";
  const maxWorkers = document.getElementById("max_workers")?.value || "4";
  const maxBudget = document.getElementById("max_budget_tokens")?.value || "8000000";
  const createPr = document.getElementById("create_pr")?.value === "true";
  const prompt = document.getElementById("user_prompt")?.value.trim();

  if (!pat || !controlRepo || !targetRepo || !prompt || !uiSecret) {
    alert("Missing required fields: PAT, Control Repo, UI Secret, Target Repo, and Goal are mandatory.");
    return;
  }

  const btn = document.getElementById("dispatch-btn");
  if (btn) btn.disabled = true;

  setBadge("running", "Dispatching...");
  appendLog("INIT", "ORCHESTRATOR", `Triggering ${mode.toUpperCase()} on '${controlRepo}' for target '${targetRepo}'...`);

  try {
    const response = await fetch(
      `https://api.github.com/repos/${controlRepo}/actions/workflows/agent.yml/dispatches`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${pat}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          ref: "main",
          inputs: {
            target_repo: targetRepo,
            target_branch: targetBranch,
            user_prompt: prompt,
            execution_mode: mode,
            max_workers: String(maxWorkers),
            max_budget_tokens: String(maxBudget),
            create_pr: createPr,
            ui_secret: uiSecret
          }
        })
      }
    );

    if (!response.ok) {
      const err = await response.json().catch(() => ({ message: response.statusText }));
      throw new Error(err.message || response.statusText);
    }

    appendLog("INIT", "RUNNER", "Workflow dispatch accepted. Polling GitHub Actions runner queue...");
    setBadge("running", "Agent Booting");

    // Wait 5 seconds for GitHub Actions to register the run before querying
    setTimeout(() => startWorkflowPolling(pat, controlRepo), 5000);
  } catch (err) {
    appendLog("ERROR", "DISPATCH", `Failed to trigger workflow: ${err.message}`);
    setBadge("", "Dispatch Failed");
    if (btn) btn.disabled = false;
  }
}
window.dispatchSwarm = dispatchSwarm;

/**
 * Continuous Log and Status Poller
 */
function startWorkflowPolling(pat, controlRepo) {
  if (pollingTimer) clearInterval(pollingTimer);
  pollCounter = 0;
  processedLogBytes = 0;

  pollingTimer = setInterval(async () => {
    try {
      pollCounter++;
      const counterEl = document.getElementById("run-counter");
      if (counterEl) counterEl.innerText = `${pollCounter} Poll Events`;

      // 1. Get the most recent workflow run
      const runsRes = await fetch(
        `https://api.github.com/repos/${controlRepo}/actions/workflows/agent.yml/runs?per_page=1`,
        {
          headers: {
            Authorization: `Bearer ${pat}`,
            Accept: "application/vnd.github+json"
          }
        }
      );

      if (!runsRes.ok) return;
      const runsData = await runsRes.json();
      const run = runsData.workflow_runs?.[0];

      if (!run) return;
      currentActiveRunId = run.id;

      // 2. Track Run Status
      if (run.status === "in_progress") {
        setBadge("running", `Active (Run #${run.run_number})`);
      } else if (run.status === "queued") {
        setBadge("running", "Queued in GitHub...");
        return;
      }

      // 3. Query active job steps
      const jobsRes = await fetch(run.jobs_url, {
        headers: {
          Authorization: `Bearer ${pat}`,
          Accept: "application/vnd.github+json"
        }
      });

      if (jobsRes.ok) {
        const jobsData = await jobsRes.json();
        const mainJob = jobsData.jobs?.[0];

        if (mainJob?.steps) {
          const activeStep = mainJob.steps.find((s) => s.status === "in_progress");
          if (activeStep) {
            setBadge("running", `${activeStep.name}`);
          }
        }
      }

      // 4. Handle Completion
      if (run.status === "completed") {
        clearInterval(pollingTimer);
        const btn = document.getElementById("dispatch-btn");
        if (btn) btn.disabled = false;

        if (run.conclusion === "success") {
          setBadge("active", "Completed");
          appendLog("COMPLETED", "ORCHESTRATOR", "Swarm execution succeeded and verified.");
          await fetchAndRenderArtifacts(pat, controlRepo, run.id);
        } else {
          setBadge("", `Failed (${run.conclusion})`);
          appendLog("ERROR", "ORCHESTRATOR", `Workflow ended with conclusion: ${run.conclusion}`);
        }
      }
    } catch (err) {
      console.warn("[Polling] Error during status check:", err);
    }
  }, 4000);
}

/**
 * Downloads workflow artifacts upon completion to inspect FIELD_GUIDE & Eval Report
 */
async function fetchAndRenderArtifacts(pat, controlRepo, runId) {
  try {
    appendLog("INIT", "SYNC", "Downloading run artifacts (.agent/FIELD_GUIDE.md, eval_report.json)...");
    const artifactsRes = await fetch(
      `https://api.github.com/repos/${controlRepo}/actions/runs/${runId}/artifacts`,
      {
        headers: {
          Authorization: `Bearer ${pat}`,
          Accept: "application/vnd.github+json"
        }
      }
    );

    if (!artifactsRes.ok) return;
    const data = await artifactsRes.json();
    const artifact = data.artifacts?.find((a) => a.name.includes("swarm-telemetry"));

    if (artifact) {
      appendLog(
        "COMPLETED",
        "SYNC",
        `Artifacts archived. Download archive at: ${artifact.archive_download_url}`
      );
    }
  } catch (err) {
    console.warn("Artifact retrieval error:", err);
  }
}

/**
 * Parses structured streaming lines matching `[STREAM:TYPE] [AGENT] payload`
 */
export function parseStreamLine(line) {
  const match = line.match(/^\[STREAM:([A-Z_]+)\]\s+\[(.*?)\]\s+(.*)$/);
  if (!match) return null;

  return {
    type: match[1],
    agentId: match[2],
    text: match[3]
  };
                          }
