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
  if (modal) {
    modal.style.display = "none";
  }
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

  // Render stored custom secrets (.env injection)
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
/* Sessions Logic (1 Repo Per Session)                                        */
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
  toggleSidebar(false);
  closeModal("sessions-modal");

  const res = await fetch(`/api/sessions?id=${sessionId}`);
  const data = await res.json();
  if (!data.session) return;

  document.getElementById("current-repo-title").innerText = data.session.target_repo;
  document.getElementById("current-branch-tag").innerText = data.session.target_branch;
  document.getElementById("welcome-card")?.remove();

  // Clear feed and append previous messages
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
/* Conversational Stream & Dispatch                                           */
/* -------------------------------------------------------------------------- */
function handleInputKey(e) {
  if (e.key === "Enter" && e.shiftKey) {
    return;
  }
  if (e.key === "Enter") {
    e.preventDefault();
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

  // Disable input and show loading state
  input.disabled = true;
  const submitBtn = document.getElementById("submit-btn");
  if (submitBtn) submitBtn.disabled = true;
  setRunStatus("loading", "Processing...");

  try {
    // Append user message immediately
    appendChatBubble("user", prompt);
    input.value = "";

    // Prepare request payload
    const payload = {
      prompt,
      uiSecret,
      targetRepo,
      targetBranch,
      executionMode,
      maxWorkers: parseInt(maxWorkers),
      maxBudget: parseInt(maxBudget),
      createPr,
      customEnvs: JSON.parse(customEnvs)
    };

    // Submit to backend
    const response = await fetch('/api/dispatch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }

    const { runId } = await response.json();
    connectStream(runId);
  } catch (error) {
    console.error("Submission failed:", error);
    setRunStatus("error", `Failed: ${error.message}`);
    appendChatBubble("system", `Error processing request: ${error.message}`);
  } finally {
    // Re-enable input
    input.disabled = false;
    if (submitBtn) submitBtn.disabled = false;
  }
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
  const assistantContainer = document.createElement("div");
  assistantContainer.className = "msg-wrapper msg-assistant";
  feed.appendChild(assistantContainer);

  let streamResultBubble = null;

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
          <span class="tool-badge">🔧 ${escapeHtml(data.tool)}</span>
          <span class="tool-toggle">[view arguments]</span>
        </div>
        <div class="tool-body">${escapeHtml(JSON.stringify(data.args, null, 2))}</div>
      `;
      assistantContainer.appendChild(activeToolCard);
    } else if (type === "tool_end" && activeToolCard) {
      const out = document.createElement("div");
      out.className = "tool-body open";
      out.innerText = `Output:\n${data.preview}`;
      activeToolCard.appendChild(out);
      activeToolCard = null;
    } else if (type === "token_ledger") {
      const counter = document.getElementById("token-counter");
      if (counter && data.totalConsumed) {
        counter.innerText = `${data.totalConsumed.toLocaleString()} tokens`;
      }
    } else if (type === "completed") {
      streamResultBubble = document.createElement("div");
      streamResultBubble.className = "result-bubble";
      streamResultBubble.innerHTML = `<b>🎉 Mission Completed</b><p style="margin-top:6px;">${escapeHtml(data.summary)}</p>`;
      assistantContainer.appendChild(streamResultBubble);
      setRunStatus("active", "Completed");
      eventSource.close();
    } else if (type === "error") {
      const errEl = document.createElement("div");
      errEl.className = "result-bubble";
      errEl.style.borderColor = "var(--accent-rose)";
      errEl.innerHTML = `<b style="color:var(--accent-rose);">❌ Mission Failed</b><p style="margin-top:6px;">${escapeHtml(data.error || data.message)}</p>`;
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
