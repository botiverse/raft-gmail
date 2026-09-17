# Raft Gmail self-hosted service RFC

## Product contract

A Raft human may connect multiple Gmail accounts. For each account, that human controls which exact Raft Agents may use `gmail.read` and `gmail.draft`. A draft-granted Agent may create or update a draft without per-item approval. No service action can send mail.

The output destination is deliberately not part of the account model. A synchronous call returns structured data to the Agent that invoked it. Any future scheduled job must store an explicit delivery target and revalidate that target at delivery time; this version has no scheduled jobs.

## Trust boundaries

| Boundary | Rule |
| --- | --- |
| Raft human | Owns connected accounts and grants on the token-bound Raft Server. |
| Raft Agent | Uses its own Login with Raft identity and a short-lived service-local session. |
| Gmail account | Holds an encrypted Google refresh token owned by one Raft human on one Server. |
| Agent grant | Names one account, one Agent ID, one Server, and one or both v1 scopes. |
| Provider token | Never returned through owner APIs, Agent actions, manifests, logs, or audit metadata. |
| Output | Returned to the caller; no fixed channel or server-side delivery guess. |

Account existence is hidden across Server boundaries: an Agent from another Server receives the same not-found shape as an absent account. Revoking a grant takes effect on the next action because authorization is read live rather than copied into the Agent session.

## Action surface

| Action | Grant | Mailbox mutation |
| --- | --- | --- |
| `gmail-search` | `gmail.read` | none |
| `gmail-read` | `gmail.read` | none |
| `gmail-draft-create` | `gmail.draft` | creates a draft |
| `gmail-draft-update` | `gmail.draft` | updates a draft |

There is no send, schedule, delete, archive, or mark-read route. The Google `gmail.compose` scope still technically permits send; this narrower contract is enforced by the service implementation and must be reviewed on every change.

## Draft idempotency

Every draft write requires a stable caller-generated operation ID.

1. Validate the request and live grant.
2. Persist a `pending` operation with a request hash before calling Gmail.
3. On a verified provider success, persist the provider draft ID and mark `succeeded`.
4. Repeating the same succeeded request returns the stored draft ID without another Gmail write.
5. Reusing the operation ID with a different payload fails.
6. A provider or transport failure after step 2 is `OPERATION_OUTCOME_UNKNOWN`; the service refuses automatic retry until an operator reconciles Gmail.

The pending marker prevents duplicate drafts in the dangerous direction. A future release should add an owner-visible reconciliation UI rather than silently clearing pending writes.

## Scheduling boundary

The default orchestration layer is the Agent: a Raft reminder wakes the Agent, the Agent calls this service, and the synchronous result returns to that Agent. This keeps timing and presentation in the component that has the live conversation context while the service remains a narrow Gmail capability boundary.

A future app-native scheduler is justified only for monitors that must run while the Agent is offline. It should be a distinct durable primitive with an owner, Gmail account, exact Agent principal, query, schedule, and app-owned result inbox. Each run must revalidate the live Agent grant. It must not persist or guess a Raft channel; the Agent retrieves the result and chooses the current destination. A future reliable Raft Agent-event delivery mechanism could replace polling without changing this stored contract.

## Data model

- `gmail_accounts`: owner Raft user, Raft Server, Gmail address, encrypted refresh token.
- `account_agent_grants`: exact Agent, Server, scopes, enabled state.
- `agent_sessions`: hash of opaque local token, Agent identity, Server, expiry.
- `draft_operations`: idempotency key, request hash, pending/succeeded state, provider draft ID.
- `audit_events`: actor, Server, account reference, action, outcome, operation ID, content-free metadata.

Deleting an account cascades its grants and draft-operation metadata. Audit rows keep the event but clear the account foreign key. Deployments must define their own retention and backup policy.

## Out of scope for v0.1

- hosted multi-tenant operation;
- app-native scheduled monitoring, result inboxes, or channel delivery;
- mail sending;
- mailbox state changes other than drafts;
- HTML-composer UI;
- Google OAuth verification on behalf of third-party operators;
- key rotation and owner-facing ambiguous-write reconciliation UI.
