CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS gmail_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_raft_user_id text NOT NULL,
  raft_server_id text NOT NULL,
  email text NOT NULL,
  encrypted_refresh_token text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_raft_user_id, raft_server_id, email)
);

CREATE TABLE IF NOT EXISTS account_agent_grants (
  gmail_account_id uuid NOT NULL REFERENCES gmail_accounts(id) ON DELETE CASCADE,
  raft_agent_id text NOT NULL,
  raft_server_id text NOT NULL,
  scopes text[] NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (gmail_account_id, raft_agent_id),
  CONSTRAINT account_agent_grants_scopes_check
    CHECK (scopes <@ ARRAY['gmail.read', 'gmail.draft']::text[])
);

CREATE TABLE IF NOT EXISTS agent_sessions (
  token_hash text PRIMARY KEY,
  raft_agent_id text NOT NULL,
  agent_name text NOT NULL,
  raft_server_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS draft_operations (
  gmail_account_id uuid NOT NULL REFERENCES gmail_accounts(id) ON DELETE CASCADE,
  raft_agent_id text NOT NULL,
  operation_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('gmail.draft.create', 'gmail.draft.update')),
  request_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'succeeded')),
  provider_draft_id text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (gmail_account_id, raft_agent_id, operation_id)
);

CREATE TABLE IF NOT EXISTS audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_type text NOT NULL CHECK (actor_type IN ('human', 'agent')),
  actor_id text NOT NULL,
  raft_server_id text NOT NULL,
  gmail_account_id uuid REFERENCES gmail_accounts(id) ON DELETE SET NULL,
  action text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('allowed', 'denied', 'succeeded', 'failed')),
  operation_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS audit_events_actor_idx
  ON audit_events (raft_server_id, actor_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS agent_sessions_expiry_idx
  ON agent_sessions (expires_at);
