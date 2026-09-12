// ui/app.js

let currentSessionId = null;
let currentRunId = null;
let eventSource = null;
let activeToolCard = null;
let allSessionsCache = [];

document.addEventListener("DOMContentLoaded", async () => {
  loadStoredSettings();
  await loadRecentSessions();

  const savedSessionId = localStorage.getItem("avos_active_session_id");
  if (savedSessionId) {
    await selectSession(savedSessionId);
  }
});

/* -------------------------------------------------------------------------- */
/* UI Toggle & Modal Functions                                                */
/* -------------------------------------------------------------------------- */
function toggleSidebar(forceState) {
  const sidebar = document.getElementById("sidebar");
  const backdrop = document.getElementById("drawer-backdrop");
  const isOpen = typeof forceState === "boolean" ? forceState : !sidebar.classList.contains("open");

  sidebar.classList.toggle("open", isOpen);
  backdrop.classList.toggle("show", isOpen);
}
window.toggleSidebar = toggleSidebar;

function openModal(id) {
  const modal = document.getElementById(id);
  if (modal) {
    modal.style.display = "flex";
    if (id === "sessions-modal") fetchAllSessions();
  }
}
window.openModal = openModal;

function closeModal(id) {
  const modal = document.getElementById(id);
  if (modal) modal.style.display = "none";
}
window.closeModal = closeModal;

function handleBackdropClick(e, modalId) {
  if (e.target.classList.contains("modal-backdrop")) {
    closeModal(modalId);
  }
}
window.handleBackdropClick = handleBackdropClick;

function autoResizeTextarea(textarea) {
  textarea.style.height = "auto";
  textarea.style.height = Math.min(textarea.scrollHeight, 160) + "px";
}
window.autoResizeTextarea = autoResizeTextarea;

function setQuickPrompt(text) {
  const input = document.getElementById("user-input");
  input.value = text;
  autoResizeTextarea(input);
  input.focus();
}
window.setQuickPrompt = setQuickPrompt;

/* -------------------------------------------------------------------------- */
/* Settings & Secret Management                                               */
/* -------------------------------------------------------------------------- */
function loadStoredSettings() {
  const fields = ["ui_secret", "target_repo", "target_branch", "execution_mode", "create_pr", "max_workers", "max_budget_tokens"];
  fields.forEach(f => {
    const val = localStorage.getItem(`avos_${f}`);
    const el = document.getElementById(f);
    if (val && el) el.value = val;
  });

  const envs = JSON.parse(localStorage.getItem("avos_custom_envs") || "{}");
  const container = document.getElementById("env-table");
  container.innerHTML = "";

  if (Object.keys(envs).length === 0) {
    addEnvRow("CLOUDFLARE_API_TOKEN", "");
  } else {
    Object.entries(envs).forEach(([k, v]) => addEnvRow(k, v));
  }

  updateHeaderRepoDisplay();
}

function addEnvRow(key = "", val = "") {
  const container = document.getElementById("env-table");
  const row = document.createElement("div");
  row.className = "env-row";
  row.innerHTML = `
    <input type="text" placeholder="KEY (e.g. CLOUDFLARE_API_TOKEN)" value="${escapeHtml(key)}" class="env-key">
    <input type="password" placeholder="VALUE" value="${escapeHtml(val)}" class="env-val">
    <button class="icon-btn" onclick="this.parentElement.remove()" title="Delete">✕</button>
  `;
  container.appendChild(row);
}
window.addEnvRow = addEnvRow;

function saveSettings() {
  const fields = ["ui_secret", "target_repo", "target_branch", "execution_mode", "create_pr", "max_workers", "max_budget_tokens"];
  fields.forEach(f => {
    const el = document.getElementById(f);
    if (el) localStorage.setItem(`avos_${f}`, el.value.trim());
  });

  const envRows = document.querySelectorAll(".env-row");
  const envObj = {};
  envRows.forEach(row => {
    const k = row.querySelector(".env-key").value.trim();
    const v = row.querySelector(".env-val").value.trim();
    if (k) envObj[k] = v;
  });
  localStorage.setItem("avos_custom_envs", JSON.stringify(envObj));

  updateHeaderRepoDisplay();
  closeModal("settings-modal");
}
window.saveSettings = saveSettings;

function updateHeaderRepoDisplay() {
  const targetRepo = localStorage.getItem("avos_target_repo") || "Select Repository";
  const targetBranch = localStorage.getItem("avos_target_branch") || "main";
  const mode = localStorage.getItem("avos_execution_mode") || "single";

  document.getElementById("current-repo-title").innerText = targetRepo;
  document.getElementById("current-branch-tag").innerText = targetBranch;
  document.getElementById("active-mode-label").innerText = mode === "swarm" ? "Topological Swarm" : "Single-Agent";
}

/* -------------------------------------------------------------------------- */
/* Session History & Rehydration                                              */
/* -------------------------------------------------------------------------- */
async function loadRecentSessions() {
  try {
    const res = await fetch("/api/sessions");
    const data = await res.json();
    const container = document.getElementById("recent-sessions");
    if (!data.sessions || data.sessions.length === 0) {
      container.innerHTML = '<div class="session-empty">No active sessions</div>';
      return;
    }
    allSessionsCache = data.sessions;
    container.innerHTML = data.sessions.slice(0, 5).map(s => `
      <div class="session-item ${s.id === currentSessionId ? "active" : ""}" onclick="selectSession('${s.id}')">
        ${escapeHtml(s.title || s.target_repo)}
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
    container.innerHTML = '<div class="session-empty">No matching sessions found</div>';
    return;
  }
  container.innerHTML = sessions.map(s => `
    <div class="session-item ${s.id === currentSessionId ? "active" : ""}" onclick="selectSession('${s.id}')" style="margin-bottom:6px; background:var(--bg-elevated);">
      <div style="font-weight:600;">${escapeHtml(s.title || s.target_repo)}</div>
      <div style="font-size:0.75rem; color:var(--text-muted);">${escapeHtml(s.target_repo)} (${escapeHtml(s.target_branch)})</div>
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
  localStorage.setItem("avos_active_session_id", sessionId);

  toggleSidebar(false);
  closeModal("sessions-modal");

  const res = await fetch(`/api/sessions?id=${sessionId}`);
  const data = await res.json();
  if (!data.session) return;

  document.getElementById("current-repo-title").innerText = data.session.target_repo;
  document.getElementById("current-branch-tag").innerText = data.session.target_branch;
  document.getElementById("welcome-card")?.remove();

  const feed = document.getElementById("chat-feed");
  feed.innerHTML = "";

  if (data.messages && data.messages.length > 0) {
    data.messages.filter(m => m.role === "user").forEach(m => {
      appendChatBubble("user", m.content);
    });
  }

  if (data.events && data.events.length > 0) {
    const assistantContainer = document.createElement("div");
    assistantContainer.className = "msg-wrapper msg-assistant";
    feed.appendChild(assistantContainer);

    data.events.forEach(ev => {
      let payload = {};
      try {
        payload = typeof ev.payload_json === "string" ? JSON.parse(ev.payload_json) : (ev.payload_json || {});
      } catch (_) {
        payload = {};
      }
      renderEventToContainer(ev.type, ev.agent_id, payload, assistantContainer);
    });
  }

  if (data.latestRun) {
    currentRunId = data.latestRun.id;
    if (data.latestRun.status === "queued" || data.latestRun.status === "in_progress") {
      setRunStatus("running", "Agent Active");
      connectStream(data.latestRun.id);
    } else if (data.latestRun.status === "completed") {
      setRunStatus("active", "Completed");
    } else if (data.latestRun.status === "failed") {
      setRunStatus("failed", "Failed");
    }
  }

  loadRecentSessions();
}
window.selectSession = selectSession;

function createNewSession() {
  if (eventSource) eventSource.close();
  currentSessionId = null;
  currentRunId = null;
  localStorage.removeItem("avos_active_session_id");

  const feed = document.getElementById("chat-feed");
  feed.innerHTML = `
    <div class="welcome-hero" id="welcome-card">
      <div class="hero-badge">NEW SESSION</div>
      <h2>What should the swarm build today?</h2>
      <p>Configure repository settings in ⚙️ Settings or start typing below.</p>
    </div>
  `;
  updateHeaderRepoDisplay();
  toggleSidebar(false);
  loadRecentSessions();
}
window.createNewSession = createNewSession;

/* -------------------------------------------------------------------------- */
/* Conversational Dispatch & Stream Pipeline                                  */
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
  const maxWorkers = localStorage.getItem("avos_max_workers") || "4";
  const maxBudget = localStorage.getItem("avos_max_budget_tokens") || "8000000";
  const createPr = localStorage.getItem("avos_create_pr") === "true";
  const customEnvs = localStorage.getItem("avos_custom_envs") || "{}";

  if (!uiSecret || !targetRepo) {
    openModal("settings-modal");
    return;
  }

  input.value = "";
  input.style.height = "auto";
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
        max_workers: maxWorkers,
        max_budget_tokens: maxBudget,
        create_pr: createPr,
        custom_env_json: customEnvs,
        ui_secret: uiSecret
      })
    });

    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || "Dispatch failed");

    currentSessionId = data.sessionId;
    currentRunId = data.runId;
    localStorage.setItem("avos_active_session_id", data.sessionId);

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
  let assistantContainer = feed.querySelector(".msg-assistant:last-child");
  if (!assistantContainer) {
    assistantContainer = document.createElement("div");
    assistantContainer.className = "msg-wrapper msg-assistant";
    feed.appendChild(assistantContainer);
  }

  eventSource.onmessage = (e) => {
    if (e.data.startsWith(":")) return;
    const ev = JSON.parse(e.data);
    renderEventToContainer(ev.type, ev.agentId, ev.data, assistantContainer);
    feed.scrollTop = feed.scrollHeight;

    if (ev.type === "completed") {
      setRunStatus("active", "Completed");
      eventSource.close();
    } else if (ev.type === "error") {
      setRunStatus("failed", "Failed");
      eventSource.close();
    }
  };

  eventSource.onerror = () => {
    setRunStatus("", "Stream Closed");
  };
}

function renderEventToContainer(type, agentId, data, container) {
  if (type === "thought" && data.text) {
    const card = document.createElement("div");
    card.className = "thought-card";
    card.innerText = `💭 [${agentId}]: ${data.text}`;
    container.appendChild(card);
  } else if (type === "tool_start") {
    const card = document.createElement("div");
    card.className = "tool-card";
    card.innerHTML = `
      <div class="tool-header" onclick="this.nextElementSibling.classList.toggle('open')">
        <span class="tool-badge">🔧 ${escapeHtml(data.tool)}</span>
        <span class="tool-toggle">[view arguments]</span>
      </div>
      <div class="tool-body">${escapeHtml(JSON.stringify(data.args, null, 2))}</div>
    `;
    container.appendChild(card);
  } else if (type === "tool_end") {
    const card = document.createElement("div");
    card.className = "tool-card";
    card.innerHTML = `
      <div class="tool-header" onclick="this.nextElementSibling.classList.toggle('open')">
        <span class="tool-badge" style="color:var(--accent-primary);">📄 Output: ${escapeHtml(data.tool || "")}</span>
        <span class="tool-toggle">[view output]</span>
      </div>
      <div class="tool-body open">${escapeHtml(data.preview || "No output")}</div>
    `;
    container.appendChild(card);
  } else if (type === "completed" && data.summary) {
    const bubble = document.createElement("div");
    bubble.className = "result-bubble";
    bubble.innerHTML = `<b>🎉 Mission Completed</b><p style="margin-top:6px;">${escapeHtml(data.summary)}</p>`;
    container.appendChild(bubble);
  } else if (type === "error") {
    const errEl = document.createElement("div");
    errEl.className = "result-bubble";
    errEl.style.borderColor = "var(--accent-rose)";
    errEl.innerHTML = `<b style="color:var(--accent-rose);">❌ Error</b><p style="margin-top:6px;">${escapeHtml(data.error || data.message)}</p>`;
    container.appendChild(errEl);
  }
}

function appendChatBubble(role, text) {
  const feed = document.getElementById("chat-feed");
  const wrapper = document.createElement("div");
  wrapper.className = `msg-wrapper msg-${role}`;

  if (role === "user") {
    wrapper.innerHTML = `<div class="bubble">${escapeHtml(text)}</div>`;
  } else {
    wrapper.innerHTML = `<div class="result-bubble">${escapeHtml(text)}</div>`;
  }

  feed.appendChild(wrapper);
  feed.scrollTop = feed.scrollHeight;
}

function setRunStatus(statusClass, text) {
  const badge = document.getElementById("status-badge");
  const label = document.getElementById("status-label");
  const stopBtn = document.getElementById("stop-btn");

  badge.className = `status-indicator ${statusClass}`.trim();
  label.innerText = text;
  stopBtn.style.display = statusClass === "running" ? "flex" : "none";
}

function escapeHtml(str) {
  return String(str || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
