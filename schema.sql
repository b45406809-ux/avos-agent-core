-- schema.sql

-- Drop old tables so SQLite rebuilds them with the new columns
DROP TABLE IF EXISTS task_states;
DROP TABLE IF EXISTS field_guides;
DROP TABLE IF EXISTS events;
DROP TABLE IF EXISTS runs;
DROP TABLE IF EXISTS messages;
DROP TABLE IF EXISTS sessions;

-- 1. Conversation Sessions (1 repo per session)
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
            target_repo TEXT NOT NULL,
                target_branch TEXT NOT NULL DEFAULT 'main',
                    custom_env_json TEXT DEFAULT '{}',
                        created_at INTEGER NOT NULL,
                            updated_at INTEGER NOT NULL
                            );

                            CREATE INDEX idx_sessions_updated ON sessions(updated_at DESC);

                            -- 2. Chat Message History
                            CREATE TABLE messages (
                                id INTEGER PRIMARY KEY AUTOINCREMENT,
                                    session_id TEXT NOT NULL,
                                        role TEXT NOT NULL,
                                            content TEXT NOT NULL,
                                                timestamp INTEGER NOT NULL,
                                                    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
                                                    );

                                                    CREATE INDEX idx_messages_session ON messages(session_id, id ASC);

                                                    -- 3. Execution Runs
                                                    CREATE TABLE runs (
                                                        id TEXT PRIMARY KEY,
                                                            session_id TEXT NOT NULL,
                                                                target_repo TEXT NOT NULL,
                                                                    target_branch TEXT NOT NULL DEFAULT 'main',
                                                                        user_prompt TEXT NOT NULL,
                                                                            execution_mode TEXT NOT NULL DEFAULT 'single',
                                                                                status TEXT NOT NULL DEFAULT 'queued',
                                                                                    created_at INTEGER NOT NULL,
                                                                                        finished_at INTEGER,
                                                                                            token_usage_json TEXT DEFAULT '{}',
                                                                                                summary TEXT,
                                                                                                    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
                                                                                                    );

                                                                                                    CREATE INDEX idx_runs_session ON runs(session_id);

                                                                                                    -- 4. Real-Time Telemetry Stream Events
                                                                                                    CREATE TABLE events (
                                                                                                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                                                                                                            run_id TEXT NOT NULL,
                                                                                                                session_id TEXT,
                                                                                                                    timestamp INTEGER NOT NULL,
                                                                                                                        type TEXT NOT NULL,
                                                                                                                            agent_id TEXT NOT NULL,
                                                                                                                                payload_json TEXT NOT NULL DEFAULT '{}',
                                                                                                                                    FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
                                                                                                                                    );

                                                                                                                                    CREATE INDEX idx_events_run_id_seq ON events(run_id, id ASC);

                                                                                                                                    -- 5. Stigmergic Field Guides
                                                                                                                                    CREATE TABLE field_guides (
                                                                                                                                        session_id TEXT PRIMARY KEY,
                                                                                                                                            detected_stack TEXT DEFAULT 'Unknown',
                                                                                                                                                test_command TEXT DEFAULT '',
                                                                                                                                                    content_md TEXT NOT NULL,
                                                                                                                                                        updated_at INTEGER NOT NULL,
                                                                                                                                                            FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
                                                                                                                                                            );