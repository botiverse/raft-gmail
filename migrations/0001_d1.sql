PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS gmail_accounts (
  id TEXT PRIMARY KEY,
  owner_raft_user_id TEXT NOT NULL,
  raft_server_id TEXT NOT NULL,
  email TEXT NOT NULL,
  encrypted_refresh_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (owner_raft_user_id, raft_server_id, email)
);

CREATE TABLE IF NOT EXISTS account_agent_grants (
  gmail_account_id TEXT NOT NULL REFERENCES gmail_accounts(id) ON DELETE CASCADE,
  raft_agent_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  raft_server_id TEXT NOT NULL,
  scopes_json TEXT NOT NULL CHECK (json_valid(scopes_json)),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (gmail_account_id, raft_agent_id)
);

CREATE TABLE IF NOT EXISTS agent_access_requests (
  id TEXT PRIMARY KEY,
  owner_raft_user_id TEXT NOT NULL,
  raft_server_id TEXT NOT NULL,
  raft_agent_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  requested_scopes_json TEXT NOT NULL CHECK (json_valid(requested_scopes_json)),
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied')),
  decision_nonce TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  decided_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_access_requests_one_pending_idx
  ON agent_access_requests (owner_raft_user_id, raft_server_id, raft_agent_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS agent_access_requests_owner_idx
  ON agent_access_requests (owner_raft_user_id, raft_server_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS agent_sessions (
  token_hash TEXT PRIMARY KEY,
  raft_agent_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  raft_server_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS agent_sessions_expiry_idx ON agent_sessions (expires_at);

CREATE TABLE IF NOT EXISTS draft_operations (
  gmail_account_id TEXT NOT NULL REFERENCES gmail_accounts(id) ON DELETE CASCADE,
  raft_agent_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('gmail.draft.create', 'gmail.draft.update')),
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded')),
  provider_draft_id TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (gmail_account_id, raft_agent_id, operation_id)
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  occurred_at TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('human', 'agent')),
  actor_id TEXT NOT NULL,
  raft_server_id TEXT NOT NULL,
  gmail_account_id TEXT REFERENCES gmail_accounts(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('allowed', 'denied', 'succeeded', 'failed')),
  operation_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json))
);

CREATE INDEX IF NOT EXISTS audit_events_actor_idx
  ON audit_events (raft_server_id, actor_id, occurred_at DESC);
