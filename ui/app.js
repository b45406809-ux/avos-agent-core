// ui/app.js
let currentSessionId = null;
let currentRunId = null;
let eventSource = null;
let activeToolCard = null;
let allSessionsCache = [];

document.addEventListener("DOMContentLoaded", () => {
  loadStoredSettings();
  loadRecentSessions();
});

function toggleSidebar() {
  document.getElementById("sidebar").classList.toggle("open");
}
window.toggleSidebar = toggleSidebar;

function openModal(id) {
  document.getElementById(id).style.display = "flex";
  if (id === "sessions-modal") fetchAllSessions();
}
window.openModal = openModal;

function closeModal(id) {
  document.getElementById(id).style.display = "none";
}
window.closeModal = closeModal;

/* -------------------------------------------------------------------------- */
/* Settings & Custom Secret Storage                                           */
/* -------------------------------------------------------------------------- */
function loadStoredSettings() {
  const fields = ["ui_secret", "target_repo", "target_branch", "execution_mode", "create_pr"];
  fields.forEach(f => {
    const val = localStorage.getItem(`avos_${f}`);
    if (val && document.getElementById(f)) document.getElementById(f).value = val;
  });

  const envs = JSON.parse(localStorage.getItem("avos_custom_envs") || "{}");
  const container = document.getElementById("env-table");
  container.innerHTML = "";
  Object.entries(envs).forEach(([k, v]) => addEnvRow(k, v));
}

function addEnvRow(key = "", val = "") {
  const container = document.getElementById("env-table");
  const row = document.createElement("div");
  row.className = "env-row";
  row.innerHTML = `
    <input type="text" placeholder="KEY (e.g. CLOUDFLARE_API_TOKEN)" value="${escapeHtml(key)}" class="env-key">
    <input type="password" placeholder="VALUE" value="${escapeHtml(val)}" class="env-val">
    <button class="icon-btn" onclick="this.parentElement.remove()">✕</button>
  `;
  container.appendChild(row);
}
window.addEnvRow = addEnvRow;

function saveSettings() {
  const fields = ["ui_secret", "target_repo", "target_branch", "execution_mode", "create_pr"];
  fields.forEach(f => {
    const el = document.getElementById(f);
    if (el) localStorage.setItem(`avos_${f}`, el.value);
  });

  const envRows = document.querySelectorAll(".env-row");
  const envObj = {};
  envRows.forEach(row => {
    const k = row.querySelector(".env-key").value.trim();
    const v = row.querySelector(".env-val").value.trim();
    if (k) envObj[k] = v;
  });
  localStorage.setItem("avos_custom_envs", JSON.stringify(envObj));

  // Update header display
  const targetRepo = document.getElementById("target_repo")?.value || "Select Target Repo";
  const targetBranch = document.getElementById("target_branch")?.value || "main";
  if (!currentSessionId) {
    document.getElementById("current-repo-title").innerText = targetRepo;
    document.getElementById("current-branch-tag").innerText = targetBranch;
  }

  closeModal("settings-modal");
}
window.saveSettings = saveSettings;

/* -------------------------------------------------------------------------- */
/* Session Management (One Repo Per Session)                                  */
/* -------------------------------------------------------------------------- */
async function loadRecentSessions() {
  try {
    const res = await fetch("/api/sessions");
    const data = await res.json();
    const container = document.getElementById("recent-sessions");
    if (!data.sessions || data.sessions.length === 0) {
      container.innerHTML = '<div class="session-placeholder">No past sessions</div>';
      return;
    }
    allSessionsCache = data.sessions;
    container.innerHTML = data.sessions.slice(0, 5).map(s => `
      <div class="session-item ${s.id === currentSessionId ? "active" : ""}" onclick="selectSession('${s.id}')">
        📁 ${escapeHtml(s.title || s.target_repo)}
      </div>
    `).join("");
  } catch (_) {}
}

async function fetchAllSessions() {
  try {
    const res = await fetch("/api/sessions");
    const data = await res.json();
    allSessionsCache = data.sessions || [];
    renderAllSessionsList(allSessionsCache);
  } catch (_) {}
}

function renderAllSessionsList(sessions) {
  const container = document.getElementById("all-sessions-list");
  if (sessions.length === 0) {
    container.innerHTML = '<div class="session-placeholder">No sessions found</div>';
    return;
  }
  container.innerHTML = sessions.map(s => `
    <div class="session-item ${s.id === currentSessionId ? "active" : ""}" onclick="selectSession('${s.id}')">
      <div><b>${escapeHtml(s.title || s.target_repo)}</b></div>
      <div style="font-size:0.7rem; color:var(--text-muted);">${escapeHtml(s.target_repo)} (${escapeHtml(s.target_branch)})</div>
    </div>
  `).join("");
}

function filterSessions() {
  const query = document.getElementById("session-search").value.toLowerCase();
  const filtered = allSessionsCache.filter(s =>
    (s.title && s.title.toLowerCase().includes(query)) ||
    (s.target_repo && s.target_repo.toLowerCase().includes(query))
  );
  renderAllSessionsList(filtered);
}
window.filterSessions = filterSessions;

async function selectSession(sessionId) {
  if (eventSource) eventSource.close();
  currentSessionId = sessionId;
  document.getElementById("sidebar").classList.remove("open");
  closeModal("sessions-modal");

  const res = await fetch(`/api/sessions?id=${sessionId}`);
  const data = await res.json();
  if (!data.session) return;

  document.getElementById("current-repo-title").innerText = data.session.target_repo;
  document.getElementById("current-branch-tag").innerText = data.session.target_branch;
  document.getElementById("welcome-card")?.remove();

  // Populate conversation feed with message history
  const feed = document.getElementById("chat-feed");
  feed.innerHTML = "";
  data.messages.forEach(m => {
    appendChatBubble(m.role, m.content);
  });

  loadRecentSessions();
}
window.selectSession = selectSession;

function createNewSession() {
  if (eventSource) eventSource.close();
  currentSessionId = null;
  currentRunId = null;
  document.getElementById("chat-feed").innerHTML = `
    <div class="welcome-card" id="welcome-card">
      <h3>New Session Initialized</h3>
      <p>Enter your goal below to begin.</p>
    </div>
  `;
  document.getElementById("current-repo-title").innerText = document.getElementById("target_repo")?.value || "Select Target Repo";
  document.getElementById("sidebar").classList.remove("open");
  loadRecentSessions();
}
window.createNewSession = createNewSession;

/* -------------------------------------------------------------------------- */
/* Conversational Dispatch & Live SSE Streaming                               */
/* -------------------------------------------------------------------------- */
function handleInputKey(e) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    submitMessage();
  }
}
window.handleInputKey = handleInputKey;

async function submitMessage() {
  const input = document.getElementById("user-input");
  const prompt = input.value.trim();
  if (!prompt) return;

  const uiSecret = localStorage.getItem("avos_ui_secret");
  const targetRepo = localStorage.getItem("avos_target_repo");
  const targetBranch = localStorage.getItem("avos_target_branch") || "main";
  const executionMode = localStorage.getItem("avos_execution_mode") || "single";
  const customEnvs = localStorage.getItem("avos_custom_envs") || "{}";

  if (!uiSecret || !targetRepo) {
    openModal("settings-modal");
    return;
  }

  input.value = "";
  document.getElementById("welcome-card")?.remove();
  appendChatBubble("user", prompt);
  setRunStatus("running", "Agent Active");

  try {
    const res = await fetch("/api/dispatch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: currentSessionId,
        target_repo: targetRepo,
        target_branch: targetBranch,
        user_prompt: prompt,
        execution_mode: executionMode,
        custom_env_json: customEnvs,
        ui_secret: uiSecret
      })
    });

    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || "Dispatch failed");

    currentSessionId = data.sessionId;
    currentRunId = data.runId;
    loadRecentSessions();
    connectStream(data.runId);
  } catch (err) {
    appendChatBubble("assistant", `🚨 Dispatch Error: ${err.message}`);
    setRunStatus("failed", "Failed");
  }
}
window.submitMessage = submitMessage;

function stopExecution() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  setRunStatus("", "Stopped by user");
}
window.stopExecution = stopExecution;

function connectStream(runId) {
  if (eventSource) eventSource.close();
  eventSource = new EventSource(`/api/stream?runId=${encodeURIComponent(runId)}`);

  const feed = document.getElementById("chat-feed");
  let assistantContainer = document.createElement("div");
  assistantContainer.className = "msg-row msg-assistant";
  feed.appendChild(assistantContainer);

  eventSource.onmessage = (e) => {
    if (e.data.startsWith(":")) return;
    const ev = JSON.parse(e.data);
    const { type, data, agentId } = ev;

    if (type === "thought") {
      const card = document.createElement("div");
      card.className = "thought-card";
      card.innerText = `💭 [${agentId}]: ${data.text}`;
      assistantContainer.appendChild(card);
    } else if (type === "tool_start") {
      activeToolCard = document.createElement("div");
      activeToolCard.className = "tool-card";
      activeToolCard.innerHTML = `
        <div class="tool-header" onclick="this.nextElementSibling.classList.toggle('open')">
          <span>🔧 ${escapeHtml(data.tool)}</span>
          <span style="font-size:0.7rem;">[toggle details]</span>
        </div>
        <div class="tool-body">${escapeHtml(JSON.stringify(data.args, null, 2))}</div>
      `;
      assistantContainer.appendChild(activeToolCard);
    } else if (type === "tool_end" && activeToolCard) {
      const out = document.createElement("div");
      out.className = "tool-body open";
      out.style.borderTop = "1px solid var(--border)";
      out.innerText = `Result:\n${data.preview}`;
      activeToolCard.appendChild(out);
      activeToolCard = null;
    } else if (type === "completed") {
      const summary = document.createElement("div");
      summary.style.marginTop = "8px";
      summary.innerHTML = `<b>✔ Finished:</b> ${escapeHtml(data.summary)}`;
      assistantContainer.appendChild(summary);
      setRunStatus("active", "Completed");
      eventSource.close();
    } else if (type === "error") {
      const errEl = document.createElement("div");
      errEl.style.color = "var(--danger)";
      errEl.innerText = `❌ Error: ${data.error || data.message}`;
      assistantContainer.appendChild(errEl);
      setRunStatus("failed", "Failed");
      eventSource.close();
    }

    feed.scrollTop = feed.scrollHeight;
  };

  eventSource.onerror = () => {
    setRunStatus("", "Stream Closed");
  };
}

function appendChatBubble(role, text) {
  const feed = document.getElementById("chat-feed");
  const row = document.createElement("div");
  row.className = `msg-row msg-${role}`;
  row.innerText = text;
  feed.appendChild(row);
  feed.scrollTop = feed.scrollHeight;
}

function setRunStatus(statusClass, text) {
  const badge = document.getElementById("status-badge");
  const stopBtn = document.getElementById("stop-btn");
  badge.className = `status-badge ${statusClass}`.trim();
  badge.innerText = text;
  stopBtn.style.display = statusClass === "running" ? "block" : "none";
}

function escapeHtml(str) {
  return String(str || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      }
