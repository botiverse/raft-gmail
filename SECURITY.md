# Security

## Reporting a vulnerability

Please do not open a public issue for a vulnerability that could expose Gmail content, OAuth tokens, Raft identity data, or cross-tenant access. Contact the Raft maintainers privately through the security contact listed on the repository.

## Operator responsibilities

This is self-hosted software. The operator is responsible for:

- protecting `RAFT_CLIENT_SECRET`, `GOOGLE_CLIENT_SECRET`, `SESSION_SECRET`, and `TOKEN_ENCRYPTION_KEY_BASE64`;
- using HTTPS and secure cookies outside local development;
- restricting database and backup access;
- rotating secrets and deleting disconnected-account data;
- reviewing Google OAuth verification and restricted-scope obligations for the deployment;
- monitoring audit events without logging email bodies or tokens.

The 32-byte token-encryption key encrypts Google refresh tokens with AES-256-GCM. Losing it makes stored Gmail connections unusable; disclosing it exposes every stored refresh token to anyone who can also read the database. This initial version does not yet implement online key rotation.

Human owner mutations require both the signed same-site session cookie and its `X-CSRF-Token` challenge. Agent actions use an independent bearer session and do not accept the human cookie as authorization.

## No-send guarantee

Google's `gmail.compose` scope permits both draft management and sending. The service's no-send guarantee comes from the smaller public manifest and implementation, not from the Google scope. CI scans production source for Gmail send calls and send routes, but review is still required when dependencies or action wiring change.

## Privacy

Owner APIs never return encrypted tokens. Agent action audit metadata excludes subjects, bodies, recipients, raw MIME, and provider tokens. Search and read results do contain authorized mailbox data and are returned only to the calling Agent; downstream handling is outside this service's boundary.
