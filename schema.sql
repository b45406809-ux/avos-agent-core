-- schema.sql

-- 1. Conversation Sessions (Scoped 1 repo per session)
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    target_repo TEXT NOT NULL,
    target_branch TEXT NOT NULL DEFAULT 'main',
    custom_env_json TEXT DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);

-- 2. Chat Message History (Multi-turn conversations)
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL, -- 'user', 'assistant', 'system'
    content TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id ASC);

-- 3. Execution Runs
CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    target_repo TEXT NOT NULL,
    target_branch TEXT NOT NULL DEFAULT 'main',
    user_prompt TEXT NOT NULL,
    execution_mode TEXT NOT NULL DEFAULT 'single',
    status TEXT NOT NULL DEFAULT 'queued', -- queued, in_progress, completed, failed
    created_at INTEGER NOT NULL,
    finished_at INTEGER,
    token_usage_json TEXT DEFAULT '{}',
    summary TEXT,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session_id);

-- 4. Real-time Telemetry Stream Events
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    session_id TEXT,
    timestamp INTEGER NOT NULL,
    type TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_events_run_id_seq ON events(run_id, id ASC);

-- 5. Stigmergic Field Guides
CREATE TABLE IF NOT EXISTS field_guides (
    session_id TEXT PRIMARY KEY,
    detected_stack TEXT DEFAULT 'Unknown',
    test_command TEXT DEFAULT '',
    content_md TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);