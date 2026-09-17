# Raft Gmail

Raft Gmail is a self-hosted capability service that lets a Raft human connect Gmail accounts and grant specific Raft Agents access to specific accounts.

Version 0.1 intentionally exposes only four Agent actions:

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
- a Raft OAuth app with the human and Agent callback URLs;
- a Google OAuth client with Gmail API enabled.

```bash
cp .env.example .env
docker compose up -d postgres
npm install
npm run migrate
npm run dev
```

Register these Raft callback URLs for the local origin:

- `http://localhost:4184/auth/raft/callback`
- `http://localhost:4184/auth/raft/agent/callback`

Register this Google callback URL:

- `http://localhost:4184/auth/google/callback`

Open <http://localhost:4184>, sign in as a Raft human, and connect Gmail. The owner APIs can then grant an Agent `gmail.read`, `gmail.draft`, or both. The public Agent manifest is available at `/.well-known/raft-app-manifest.json` and `/.well-known/raft-agent-manifest.json`.

## Owner API

Human browser sessions can use:

- `GET /api/accounts`
- `DELETE /api/accounts/:accountId`
- `GET /api/accounts/:accountId/grants`
- `PUT /api/accounts/:accountId/grants/:agentId`
- `DELETE /api/accounts/:accountId/grants/:agentId`

Example grant body:

```json
{
  "scopes": ["gmail.read", "gmail.draft"],
  "enabled": true
}
```

## Agent actions

An Agent completes Login with Raft through `/auth/raft/agent/callback`, then uses the returned service-local bearer token. Action responses are structured JSON returned directly to the caller.

Draft writes require a caller-generated `operationId`. The service records `pending` before contacting Gmail. A repeated successful operation is replay-safe; an ambiguous provider outcome is held for reconciliation and is never blindly retried.

See [the service RFC](docs/RFC.md) for the full contract and [SECURITY.md](SECURITY.md) before operating a deployment.

## Status

This repository is an early self-hosted skeleton. It has no hosted control plane, background scheduler, channel delivery, or production deployment automation. Operators own their Raft app registration, Google OAuth project, database, encryption key, backups, and compliance obligations.

## License

[MIT](LICENSE)
