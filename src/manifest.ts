type ActionParameter = {
  type: string;
  description: string;
  required?: boolean;
};

export function buildManifest(appOrigin: string, service = "raft-gmail") {
  return {
    schema: "raft-agent-manifest.v0" as const,
    service,
    name: "Raft Gmail",
    description: "Self-hosted Gmail read, draft, and scheduled-send capabilities controlled by per-account Raft Agent grants.",
    app_origin: appOrigin,
    execution: {
      mode: "http_api" as const,
      base_url: appOrigin
    },
    auth: {
      type: "login_with_raft" as const,
      login_url: `${appOrigin}/auth/raft/login`
    },
    actions: [
      action(
        "gmail-accounts-list",
        "/actions/gmail-accounts-list",
        "List Gmail accounts and scopes currently authorized for this Agent.",
        {}
      ),
      action(
        "gmail-access-request",
        "/actions/gmail-access-request",
        "Request human approval for read, draft, and/or scheduled-send access to selected Gmail accounts.",
        {
          ownerRef: { type: "string", description: "Signed owner reference copied from the owner's dashboard.", required: true },
          scopes: { type: "string[]", description: "Requested capabilities: gmail.read, gmail.draft, and/or gmail.schedule.", required: true },
          reason: { type: "string", description: "Why the Agent needs this access.", required: true }
        }
      ),
      action(
        "gmail-search",
        "/actions/gmail-search",
        "Search an authorized Gmail account without changing mailbox state.",
        {
          accountId: { type: "string", description: "Authorized Gmail account UUID.", required: true },
          query: { type: "string", description: "Gmail search query.", required: true },
          maxResults: { type: "number", description: "Maximum results from 1 to 100." }
        }
      ),
      action(
        "gmail-read",
        "/actions/gmail-read",
        "Read one message from an authorized Gmail account.",
        {
          accountId: { type: "string", description: "Authorized Gmail account UUID.", required: true },
          messageId: { type: "string", description: "Gmail message ID.", required: true }
        }
      ),
      action(
        "gmail-draft-create",
        "/actions/gmail-draft-create",
        "Create a draft in an authorized Gmail account.",
        draftParameters()
      ),
      action(
        "gmail-draft-update",
        "/actions/gmail-draft-update",
        "Update an existing draft in an authorized Gmail account.",
        {
          ...draftParameters(),
          draftId: { type: "string", description: "Existing Gmail draft ID.", required: true }
        }
      ),
      action(
        "gmail-scheduled-send-create",
        "/actions/gmail-scheduled-send-create",
        "Create a Gmail draft now and send it once at a future time. Requires the separate gmail.schedule grant.",
        {
          ...draftParameters(),
          scheduledFor: {
            type: "string",
            description: "ISO 8601 timestamp between 1 minute and 365 days in the future.",
            required: true
          }
        }
      ),
      action(
        "gmail-scheduled-send-list",
        "/actions/gmail-scheduled-send-list",
        "List this Agent's scheduled-send jobs for one authorized Gmail account without returning message content.",
        {
          accountId: { type: "string", description: "Authorized Gmail account UUID.", required: true }
        }
      ),
      action(
        "gmail-scheduled-send-cancel",
        "/actions/gmail-scheduled-send-cancel",
        "Cancel this Agent's scheduled email while it is still waiting to send.",
        {
          accountId: { type: "string", description: "Authorized Gmail account UUID.", required: true },
          scheduledEmailId: { type: "string", description: "Scheduled email UUID returned by create or list.", required: true }
        }
      )
    ],
    credential_boundary: {
      storage: "slock_managed_token" as const,
      forbid_user_home: true
    },
    unsupported: [
      "gmail.send",
      "gmail.delete",
      "gmail.archive",
      "gmail.mark_read",
      "google_token.expose",
      "raft_token.expose",
      "fixed_channel_delivery"
    ]
  };
}

function action(
  name: string,
  path: string,
  description: string,
  parameters: Record<string, ActionParameter>
) {
  return {
    name,
    description,
    endpoint: { method: "POST" as const, path },
    parameters
  };
}

function draftParameters(): Record<string, ActionParameter> {
  return {
    accountId: { type: "string", description: "Authorized Gmail account UUID.", required: true },
    operationId: { type: "string", description: "Caller-generated idempotency key.", required: true },
    to: { type: "string[]", description: "Draft recipient addresses.", required: true },
    cc: { type: "string[]", description: "Optional CC recipient addresses." },
    subject: { type: "string", description: "Draft subject.", required: true },
    bodyText: {
      type: "string",
      description: "Plain-text draft body, also used as the text alternative when bodyHtml is present.",
      required: true
    },
    bodyHtml: { type: "string", description: "Optional HTML draft body. Creates a multipart/alternative draft." },
    threadId: { type: "string", description: "Optional Gmail thread ID." }
  };
}
