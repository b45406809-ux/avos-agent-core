CREATE TABLE IF NOT EXISTS setup_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  status TEXT NOT NULL,
  nonce_hash TEXT,
  nonce_expires_at INTEGER,
  nonce_used_at INTEGER,
  github_manifest_state_hash TEXT,
  github_manifest_expires_at INTEGER,
  github_app_id TEXT,
  github_client_id TEXT,
  github_installation_id TEXT,
  control_repository TEXT,
  repository_allowlist TEXT,
  github_tested_at INTEGER,
  provider_tested_at INTEGER,
  smoke_tested_at INTEGER,
  degraded_policy TEXT NOT NULL DEFAULT 'disabled',
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS encrypted_credentials (
  id TEXT PRIMARY KEY,
  credential_type TEXT NOT NULL,
  provider TEXT,
  key_version INTEGER NOT NULL,
  nonce TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  validated_at INTEGER,
  disabled_at INTEGER
);
CREATE INDEX IF NOT EXISTS encrypted_credentials_provider ON encrypted_credentials(provider, disabled_at);

CREATE TABLE IF NOT EXISTS provider_settings (
  provider TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  models_json TEXT NOT NULL DEFAULT '[]',
  last_validated_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS model_routing (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  primary_planner TEXT,
  fallback_planner TEXT,
  primary_worker TEXT,
  fallback_worker TEXT,
  compaction_model TEXT,
  maximum_tokens INTEGER NOT NULL DEFAULT 100000,
  maximum_estimated_cost REAL NOT NULL DEFAULT 0,
  degraded_policy TEXT NOT NULL DEFAULT 'disabled',
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS setup_rate_limits (
  key TEXT PRIMARY KEY,
  window_started_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL
);
