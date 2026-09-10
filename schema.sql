-- ============================================================================
-- Cloudflare D1 Edge SQLite Schema for AVOS Agent Core
-- ============================================================================

-- Drop existing tables during clean migrations if needed
-- DROP TABLE IF EXISTS task_states;
-- DROP TABLE IF EXISTS field_guides;
-- DROP TABLE IF EXISTS events;
-- DROP TABLE IF EXISTS runs;

-- ----------------------------------------------------------------------------
-- 1. Mission Runs Table
-- Tracks every autonomous execution dispatch, target repo, and completion state.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,                       -- e.g. "run_1773288000_abc12"
    target_repo TEXT NOT NULL,                 -- e.g. "owner/project-repo"
    target_branch TEXT NOT NULL DEFAULT 'main',
    user_prompt TEXT NOT NULL,                 -- User goal / architectural task
    execution_mode TEXT NOT NULL DEFAULT 'swarm', -- 'swarm' (DAG) or 'single' (ReAct)
    status TEXT NOT NULL DEFAULT 'queued',     -- 'queued', 'in_progress', 'completed', 'failed'
    created_at INTEGER NOT NULL,               -- Unix epoch timestamp (ms)
    finished_at INTEGER,                       -- Unix epoch timestamp (ms)
    token_usage_json TEXT DEFAULT '{}',        -- Aggregated prompt/completion tokens
    summary TEXT                               -- Final run completion summary
);

-- Index for fast reverse-chronological dashboard queries
CREATE INDEX IF NOT EXISTS idx_runs_created_at ON runs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);

-- ----------------------------------------------------------------------------
-- 2. Telemetry & Live Event Stream Table
-- Powers the real-time Server-Sent Events (SSE) stream to the web UI.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,      -- Monotonically increasing event sequence ID
    run_id TEXT NOT NULL,                      -- References runs(id)
    timestamp INTEGER NOT NULL,                -- Unix epoch timestamp (ms)
    type TEXT NOT NULL,                        -- 'init', 'thought', 'tool_start', 'tool_end', 'test_verify', etc.
    agent_id TEXT NOT NULL,                    -- 'ORCHESTRATOR', 'PLANNER', 'WORKER-1', 'REFEREE', 'GOVERNOR'
    payload_json TEXT NOT NULL DEFAULT '{}',   -- Tool arguments, stdout/stderr, diff snippets
    FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
);

-- Compound index optimized for SSE polling: "WHERE run_id = ? AND id > ? ORDER BY id ASC"
CREATE INDEX IF NOT EXISTS idx_events_run_id_seq ON events(run_id, id ASC);

-- ----------------------------------------------------------------------------
-- 3. Dynamic Field Guide (Stigmergy Blackboard)
-- Persists the generated architectural map, entry points, and worker contracts.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS field_guides (
    run_id TEXT PRIMARY KEY,                   -- References runs(id)
    detected_stack TEXT DEFAULT 'Unknown',     -- e.g. "Rust (Cargo)", "TypeScript (Node.js)"
    package_manager TEXT DEFAULT 'Unknown',    -- e.g. "cargo", "pnpm", "npm", "pytest"
    test_command TEXT DEFAULT '',              -- e.g. "cargo test", "npm test"
    content_md TEXT NOT NULL,                  -- Full live FIELD_GUIDE.md markdown
    contracts_json TEXT DEFAULT '{}',          -- Registered module interfaces (Stigmergy)
    updated_at INTEGER NOT NULL,               -- Unix epoch timestamp (ms)
    FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
);

-- ----------------------------------------------------------------------------
-- 4. Task DAG & Verification State Table
-- Tracks individual atomic units of work decomposed by the Lead Architect.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS task_states (
    run_id TEXT NOT NULL,                      -- References runs(id)
    task_id TEXT NOT NULL,                     -- e.g. "TASK-01", "TASK-02"
    description TEXT NOT NULL,
    files_targeted_json TEXT DEFAULT '[]',     -- JSON array of relative paths
    dependencies_json TEXT DEFAULT '[]',       -- JSON array of prerequisite task IDs
    verification_command TEXT NOT NULL,        -- Assigned test oracle command
    status TEXT NOT NULL DEFAULT 'PENDING',    -- 'PENDING', 'IN_PROGRESS', 'VERIFIED', 'FAILED'
    summary TEXT DEFAULT '',
    updated_at INTEGER NOT NULL,               -- Unix epoch timestamp (ms)
    PRIMARY KEY (run_id, task_id),
    FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_task_states_run_id ON task_states(run_id);
