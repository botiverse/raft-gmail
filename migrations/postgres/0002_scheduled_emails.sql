ALTER TABLE account_agent_grants
  DROP CONSTRAINT IF EXISTS account_agent_grants_scopes_check;

ALTER TABLE account_agent_grants
  ADD CONSTRAINT account_agent_grants_scopes_check
  CHECK (scopes <@ ARRAY['gmail.read', 'gmail.draft', 'gmail.schedule']::text[]);

ALTER TABLE agent_access_requests
  DROP CONSTRAINT IF EXISTS agent_access_requests_scopes_check;

ALTER TABLE agent_access_requests
  ADD CONSTRAINT agent_access_requests_scopes_check
  CHECK (requested_scopes <@ ARRAY['gmail.read', 'gmail.draft', 'gmail.schedule']::text[]);

CREATE TABLE IF NOT EXISTS scheduled_emails (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gmail_account_id uuid NOT NULL REFERENCES gmail_accounts(id) ON DELETE CASCADE,
  raft_agent_id text NOT NULL,
  raft_server_id text NOT NULL,
  operation_id text NOT NULL,
  request_hash text NOT NULL,
  provider_draft_id text,
  provider_message_id text,
  scheduled_for timestamptz NOT NULL,
  status text NOT NULL CHECK (
    status IN ('preparing', 'scheduled', 'sending', 'sent', 'canceled', 'outcome_unknown')
  ),
  failure_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  canceled_at timestamptz,
  UNIQUE (gmail_account_id, raft_agent_id, operation_id)
);

CREATE INDEX IF NOT EXISTS scheduled_emails_due_idx
  ON scheduled_emails (status, scheduled_for);

CREATE INDEX IF NOT EXISTS scheduled_emails_agent_idx
  ON scheduled_emails (raft_server_id, raft_agent_id, gmail_account_id, created_at DESC);
