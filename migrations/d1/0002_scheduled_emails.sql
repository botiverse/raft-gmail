PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS scheduled_emails (
  id TEXT PRIMARY KEY,
  gmail_account_id TEXT NOT NULL REFERENCES gmail_accounts(id) ON DELETE CASCADE,
  raft_agent_id TEXT NOT NULL,
  raft_server_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  provider_draft_id TEXT,
  provider_message_id TEXT,
  scheduled_for TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('preparing', 'scheduled', 'sending', 'sent', 'canceled', 'outcome_unknown')
  ),
  failure_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sent_at TEXT,
  canceled_at TEXT,
  UNIQUE (gmail_account_id, raft_agent_id, operation_id)
);

CREATE INDEX IF NOT EXISTS scheduled_emails_due_idx
  ON scheduled_emails (status, scheduled_for);

CREATE INDEX IF NOT EXISTS scheduled_emails_agent_idx
  ON scheduled_emails (raft_server_id, raft_agent_id, gmail_account_id, created_at DESC);
