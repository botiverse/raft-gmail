# Raft Gmail

Raft Gmail is a self-hosted capability service that lets a Raft human connect Gmail accounts and grant specific Raft Agents access to specific accounts.

Version 0.1 exposes nine Agent actions:

- list Gmail accounts and scopes currently authorized for the calling Agent;
- request human approval for Gmail access;
- search mail;
- read a message;
- create a Gmail draft;
- update a Gmail draft;
- create a scheduled send;
- list the calling Agent's scheduled sends for one account;
- cancel a scheduled send that has not started.

It does **not** expose immediate send, delete, archive, or mark-read actions. `gmail.schedule` is a separate, explicit grant: the service creates a Gmail draft immediately and sends that draft once at the requested future time.

## Identity and authorization

Raft Gmail uses two independent identity layers:

1. **Login with Raft** identifies the human account owner or calling Agent and binds that principal to the token's Raft Server.
2. **Google OAuth** is completed by the human owner for each Gmail account they connect.

The service stores Google refresh tokens encrypted at rest. Agents receive an opaque service-local session and never receive a Google token or raw Raft token. Grants are scoped by Gmail account, Raft Server, exact Agent ID, and capability (`gmail.read`, `gmail.draft`, or `gmail.schedule`).

Ordinary action results are returned to the calling Agent. The service does not store or guess a destination Raft channel.

## Important Google scope boundary

Google does not offer a general OAuth scope that permits draft creation but cryptographically forbids sending. `gmail.compose` permits both. Raft Gmail therefore enforces its narrower contract in the public action manifest, HTTP routes, source, and regression checks: draft actions never send, and the only provider send call is owned by the scheduled worker after a live `gmail.schedule` grant check. Treat the self-host operator as part of the trusted computing base.

## Run locally

Requirements:

- Node.js 22 or newer;
- PostgreSQL 15 or newer;
- a Raft OAuth app with the shared human/Agent callback URL;
- a Google OAuth client with Gmail API enabled.

```bash
cp .env.example .env
docker compose up -d postgres
npm install
npm run migrate
npm run dev
```

`npm run dev` starts the owner dashboard at <http://localhost:5173> and proxies its API and OAuth routes to the service on port 4184. Register this Raft callback URL for that local origin:

- `http://localhost:5173/auth/raft/callback`

Human and Agent Login with Raft intentionally share this one callback. The service uses the exchanged principal type to establish either a human browser session or a service-local Agent session.

Register this Google callback URL:

- `http://localhost:5173/auth/google/callback`

Open <http://localhost:5173> and use the owner dashboard to:

1. sign in with Raft as a human;
2. connect one or more Gmail accounts;
3. choose **Add Agent**, copy the generated prompt into a conversation with the Agent, and let the Agent submit a request with its authenticated Raft identity;
4. open **Access requests**, choose one or more Gmail accounts, and approve any requested subset of read, draft, or scheduled-send permissions (or deny the request);
5. pause, edit, or revoke any account-specific grant at any time.

The dashboard deliberately has no compose or send action; it only controls grants. The public Agent manifest is available at `/.well-known/raft-app-manifest.json` and `/.well-known/raft-agent-manifest.json` through either the Vite proxy or the service. It uses the `raft-agent-manifest.v0` HTTP-action contract consumed by `raft integration invoke`.

For a production-style local run, use `npm run build && npm start`; the service then serves the compiled dashboard and API together at <http://localhost:4184>. Set `APP_ORIGIN` and all registered OAuth callbacks to that deployed origin.

## Deploy on Cloudflare

The Cloudflare deployment uses one Worker for the Express API, static dashboard, and one-minute scheduled trigger, plus one D1 database. No separate PostgreSQL service is required for this runtime.

1. Create the D1 database and replace the placeholder `database_id` in `wrangler.jsonc`:

   ```bash
   npx wrangler d1 create raft-gmail
   ```

2. Apply the journaled D1 migrations from the dedicated `migrations/d1` directory:

   ```bash
   npx wrangler d1 migrations apply DB --remote
   ```

3. Store the six sensitive values as Worker secrets (never put their values in `wrangler.jsonc`):

   ```text
   SESSION_SECRET
   TOKEN_ENCRYPTION_KEY_BASE64
   RAFT_CLIENT_ID
   RAFT_CLIENT_SECRET
   GOOGLE_CLIENT_ID
   GOOGLE_CLIENT_SECRET
   ```

4. Set `APP_ORIGIN` in `wrangler.jsonc` to the exact deployed HTTPS origin. Register these callbacks against that same origin:

   - Raft human + Agent callback: `/auth/raft/callback`
   - Google callback: `/auth/google/callback`

5. Verify the build without publishing, then deploy:

   ```bash
   npm run build:cloudflare
   npm run deploy:cloudflare
   ```

After deployment, verify `/healthz`, both `/.well-known/` manifests, the owner login/connect flow, authorized-account discovery, access approval and revocation, read access, draft create/update, and a controlled scheduled-send create/list/cancel/send flow. The manifest must expose exactly the nine actions listed above and no immediate-send action.

## Owner API

Human browser sessions can use:

- `GET /api/accounts`
- `DELETE /api/accounts/:accountId`
- `GET /api/accounts/:accountId/grants`
- `GET /api/access-request-instructions`
- `GET /api/access-requests`
- `POST /api/access-requests/:requestId/approve`
- `POST /api/access-requests/:requestId/deny`
- `PUT /api/accounts/:accountId/grants/:agentId`
- `DELETE /api/accounts/:accountId/grants/:agentId`

`GET /api/session` returns the signed session's CSRF token. Send it as `X-CSRF-Token` on every owner mutation (`PUT` or `DELETE`).

The `PUT` route edits an existing approved grant; it cannot create a grant for an arbitrary Agent ID. Example edit body:

```json
{
  "scopes": ["gmail.read", "gmail.draft"],
  "enabled": true
}
```

## Agent actions

An Agent completes Login with Raft through `/auth/raft/callback`. The callback creates a service-local session, sets the signed cookie consumed by `raft integration login`, and also returns the service-local bearer token for direct API clients; the raw Raft token is never exposed. Action responses are structured JSON returned directly to the caller. Human and Agent logins share one callback because a registered Raft OAuth app has one exact return URL; the service branches only after Raft returns the authenticated principal type.

Agent sessions last one hour by default and expire exactly at their returned `expiresAt` timestamp. Expiry does not change the underlying Gmail grant; the Agent can complete Login with Raft again and continue with the same currently enabled scopes.

`gmail-accounts-list` returns only accounts with a currently enabled grant for the authenticated Agent on the same Raft Server. Each row contains the account UUID, email, Raft owner ID, granted scopes, active status, connection time, and grant update time so the Agent can select the intended account; it never returns the encrypted Google token or a separate server ID. Revoked or disabled grants disappear immediately.

`gmail-access-request` accepts the signed `ownerRef` copied from the owner's prompt, the requested scopes, and a reason. The service takes the Agent ID and display name from the authenticated Agent session. The request creates no grant until the human approves it for selected accounts.

Draft writes require a caller-generated `operationId` and a plain-text `bodyText`. Callers may also provide `bodyHtml`; the service then creates a `multipart/alternative` message with `bodyText` as the fallback and HTML as the preferred part, so Gmail opens the draft in rich-text mode. Existing callers that provide only `bodyText` continue to create the same `text/plain` message shape. The service records `pending` before contacting Gmail. A repeated successful operation is replay-safe; an ambiguous provider outcome is held for reconciliation and is never blindly retried.

`gmail-scheduled-send-create` requires a distinct `gmail.schedule` grant, the same message fields as draft creation, and a `scheduledFor` ISO 8601 timestamp from one minute to 365 days in the future. The message content is written to a Gmail draft and is not stored in Raft Gmail's database. The database keeps only content-free job metadata, the provider draft ID, and the request hash. `gmail-scheduled-send-list` returns only the calling Agent's jobs for the selected account. `gmail-scheduled-send-cancel` succeeds only while a job is still waiting.

The one-minute worker atomically claims due jobs and revalidates the live account grant immediately before calling Gmail. A revoked grant cancels the job without sending. A Gmail or transport error after claim becomes `outcome_unknown` and is never retried automatically, because retrying could duplicate a message that Gmail already accepted. A Worker crash after claim leaves the job in `sending` for manual reconciliation for the same reason.

See [the service RFC](docs/RFC.md) for the full contract and [SECURITY.md](SECURITY.md) before operating a deployment.

## Status

This repository is an early self-hosted service. It has no hosted control plane, channel delivery, or production deployment automation. Operators own their Raft app registration, Google OAuth project, database, scheduled Worker trigger, encryption key, backups, reconciliation, and compliance obligations.

## License

[MIT](LICENSE)
