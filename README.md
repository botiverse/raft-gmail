# Raft Gmail

Raft Gmail is a self-hosted capability service that lets a Raft human connect Gmail accounts and grant specific Raft Agents access to specific accounts.

Version 0.1 intentionally exposes only five Agent actions:

- request human approval for Gmail access;
- search mail;
- read a message;
- create a Gmail draft;
- update a Gmail draft.

It does **not** expose send, schedule, delete, archive, or mark-read actions. An Agent with the `gmail.draft` grant can create a draft directly, but cannot send it through this service.

## Identity and authorization

Raft Gmail uses two independent identity layers:

1. **Login with Raft** identifies the human account owner or calling Agent and binds that principal to the token's Raft Server.
2. **Google OAuth** is completed by the human owner for each Gmail account they connect.

The service stores Google refresh tokens encrypted at rest. Agents receive an opaque service-local session and never receive a Google token or raw Raft token. Grants are scoped by Gmail account, Raft Server, exact Agent ID, and capability (`gmail.read` or `gmail.draft`).

Ordinary action results are returned to the calling Agent. The service does not store or guess a destination Raft channel.

## Important Google scope boundary

Google does not offer a general OAuth scope that permits draft creation but cryptographically forbids sending. `gmail.compose` permits both. Raft Gmail therefore enforces “draft, never send” in its public action manifest, HTTP routes, source, and regression checks. Treat the self-host operator as part of the trusted computing base.

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
4. open **Access requests**, choose one or more Gmail accounts, and approve read, draft, or both permissions (or deny the request);
5. pause, edit, or revoke any account-specific grant at any time.

The dashboard deliberately has no send action. The public Agent manifest is available at `/.well-known/raft-app-manifest.json` and `/.well-known/raft-agent-manifest.json` through either the Vite proxy or the service.

For a production-style local run, use `npm run build && npm start`; the service then serves the compiled dashboard and API together at <http://localhost:4184>. Set `APP_ORIGIN` and all registered OAuth callbacks to that deployed origin.

## Deploy on Cloudflare

The Cloudflare deployment uses one Worker for the Express API and static dashboard, plus one D1 database. No separate PostgreSQL service is required for this runtime.

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

After deployment, verify `/healthz`, both `/.well-known/` manifests, the owner login/connect flow, access approval and revocation, read access, and draft create/update. The manifest must still expose exactly the five actions listed above and no send action.

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

An Agent completes Login with Raft through `/auth/raft/callback`, then uses the returned service-local bearer token. Action responses are structured JSON returned directly to the caller. Human and Agent logins share one callback because a registered Raft OAuth app has one exact return URL; the service branches only after Raft returns the authenticated principal type.

`gmail-access-request` accepts the signed `ownerRef` copied from the owner's prompt, the requested scopes, and a reason. The service takes the Agent ID and display name from the authenticated Agent session. The request creates no grant until the human approves it for selected accounts.

Draft writes require a caller-generated `operationId`. The service records `pending` before contacting Gmail. A repeated successful operation is replay-safe; an ambiguous provider outcome is held for reconciliation and is never blindly retried.

See [the service RFC](docs/RFC.md) for the full contract and [SECURITY.md](SECURITY.md) before operating a deployment.

## Status

This repository is an early self-hosted skeleton. It has no hosted control plane, background scheduler, channel delivery, or production deployment automation. Operators own their Raft app registration, Google OAuth project, database, encryption key, backups, and compliance obligations.

## License

[MIT](LICENSE)
