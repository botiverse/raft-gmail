export function buildManifest(appOrigin: string) {
  return {
    name: "Raft Gmail",
    description: "Self-hosted Gmail read and draft capabilities controlled by per-account Raft Agent grants.",
    manifestVersion: "0.1",
    appType: "http_api_with_login",
    conversationRole: "tool_api",
    baseUrl: appOrigin,
    oauth: {
      setupUrl: "https://app.raft.build/login-with-raft/setup",
      tokenUrl: "https://api.raft.build/api/oauth/token",
      userinfoUrl: "https://api.raft.build/api/oauth/userinfo",
      redirectUris: [`${appOrigin}/auth/raft/callback`, `${appOrigin}/auth/raft/agent/callback`],
      scopes: ["openid", "profile", "identity"]
    },
    agentLogin: {
      callback: `${appOrigin}/auth/raft/agent/callback`,
      returns: "service-local-agent-session",
      rawRaftTokenExposure: false,
      revoke: {
        method: "DELETE",
        path: "/api/agent/session",
        auth: "service-local-agent-session"
      }
    },
    actions: [
      action("gmail-access-request", "/actions/gmail-access-request", "Request human approval for read and/or draft access to selected Gmail accounts."),
      action("gmail-search", "/actions/gmail-search", "Search an authorized Gmail account without changing mailbox state."),
      action("gmail-read", "/actions/gmail-read", "Read one message from an authorized Gmail account."),
      action("gmail-draft-create", "/actions/gmail-draft-create", "Create a draft in an authorized Gmail account."),
      action("gmail-draft-update", "/actions/gmail-draft-update", "Update an existing draft in an authorized Gmail account.")
    ],
    unsupported: [
      "gmail.send",
      "gmail.schedule",
      "gmail.delete",
      "gmail.archive",
      "gmail.mark_read",
      "google_token.expose",
      "raft_token.expose",
      "fixed_channel_delivery"
    ]
  };
}

function action(name: string, path: string, description: string) {
  return {
    name,
    method: "POST",
    path,
    description,
    auth: { type: "service-local-agent-session" },
    response: { envelope: "public_action_envelope" }
  };
}
