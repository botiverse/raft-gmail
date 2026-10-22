# Raft Gmail self-hosted service RFC

## Product contract

A Raft human may connect multiple Gmail accounts. For each account, that human controls which exact Raft Agents may use `gmail.read`, `gmail.draft`, and `gmail.schedule`. A draft-granted Agent may create or update a draft without per-item approval. A schedule-granted Agent may create a Gmail draft for one future delivery, list its own jobs, and cancel a job before execution. There is no immediate-send action.

The Raft output destination is deliberately not part of the account model. Synchronous results return to the invoking Agent. Scheduled email recipients are stored only inside the provider draft, not in the service database; execution revalidates the exact Agent grant and account before sending.

## Trust boundaries

| Boundary | Rule |
| --- | --- |
| Raft human | Owns connected accounts and grants on the token-bound Raft Server. |
| Raft Agent | Uses its own Login with Raft identity and a short-lived service-local session. |
| Gmail account | Holds an encrypted Google refresh token owned by one Raft human on one Server. |
| Access request | Captures the authenticated Agent ID/name, requested scopes, reason, owner, and Server. It confers no capability. |
| Agent grant | Names one account, one authenticated Agent ID/name snapshot, one Server, and an explicit subset of the three scopes. |
| Provider token | Never returned through owner APIs, Agent actions, manifests, logs, or audit metadata. |
| Output | Returned to the caller; no fixed channel or server-side delivery guess. |

Account existence is hidden across Server boundaries: an Agent from another Server receives the same not-found shape as an absent account. Revoking a grant takes effect on the next action because authorization is read live rather than copied into the Agent session.

## Action surface

| Action | Grant | Mailbox mutation |
| --- | --- | --- |
| `gmail-access-request` | none; signed owner reference + authenticated Agent session | none; creates/updates a pending approval request |
| `gmail-search` | `gmail.read` | none |
| `gmail-read` | `gmail.read` | none |
| `gmail-draft-create` | `gmail.draft` | creates a draft |
| `gmail-draft-update` | `gmail.draft` | updates a draft |
| `gmail-scheduled-send-create` | `gmail.schedule` | creates a provider draft and durable future job |
| `gmail-scheduled-send-list` | `gmail.schedule` | none |
| `gmail-scheduled-send-cancel` | `gmail.schedule` | cancels a waiting job; leaves the provider draft intact |

There is no immediate-send, delete, archive, or mark-read route. The Google `gmail.compose` scope technically permits send; the service limits that provider operation to the scheduled worker after an atomic claim and live grant check.

Both draft actions require `bodyText`. An optional `bodyHtml` adds a rich-text alternative: the Gmail message is encoded as `multipart/alternative`, with the plain-text fallback first and the HTML part last. Requests without `bodyHtml` retain the original `text/plain` message shape. This is an API payload capability only; an HTML-composer UI remains out of scope.

## Access-request and approval boundary

The owner dashboard does not create a grant from a manually typed Agent ID. It creates a time-limited signed owner reference and a copyable prompt. An Agent authenticates with Login with Raft and submits that reference, requested scopes, and a reason through `gmail-access-request`; the service records the principal ID and name from the authenticated Agent session.

A human may then approve a subset of the requested scopes for one or more owned Gmail accounts, or deny the request. Approval locks and consumes one pending request and writes all selected account grants in the same database transaction. A direct grant edit only works for an existing approved grant. This makes “request” and “capability” distinct states and prevents a typed display name or UUID from conferring access.

## Draft idempotency

Every draft write requires a stable caller-generated operation ID.

1. Validate the request and live grant.
2. Persist a `pending` operation with a request hash before calling Gmail.
3. On a verified provider success, persist the provider draft ID and mark `succeeded`.
4. Repeating the same succeeded request returns the stored draft ID without another Gmail write.
5. Reusing the operation ID with a different payload fails.
6. A provider or transport failure after step 2 is `OPERATION_OUTCOME_UNKNOWN`; the service refuses automatic retry until an operator reconciles Gmail.

The pending marker prevents duplicate drafts in the dangerous direction. A future release should add an owner-visible reconciliation UI rather than silently clearing pending writes.

## Scheduled-send boundary

Scheduled send is a distinct durable primitive and capability, not a delayed invocation of the ordinary draft action.

1. Validate the request, future time, Agent session, account, and live `gmail.schedule` grant.
2. Persist a content-free `preparing` job with an idempotency key and request hash.
3. Create the Gmail draft. Message recipients, subject, and body live only in Gmail.
4. Persist the provider draft ID and move the job to `scheduled`.
5. A one-minute Worker trigger atomically claims due jobs as `sending`.
6. Re-read the account and exact Agent grant. Missing or revoked capability cancels without calling Gmail.
7. Call Gmail `users.drafts.send` once. Verified success moves to `sent`.
8. Any ambiguous provider result moves to `outcome_unknown`; the worker never retries it automatically.

Only `scheduled` jobs can be canceled by the originating Agent. Canceling leaves the Gmail draft available for human inspection. `preparing`, `sending`, and `outcome_unknown` require reconciliation rather than a second provider call. A Worker crash after the atomic claim deliberately leaves `sending`, favoring no duplicate over automatic recovery.

## Data model

- `gmail_accounts`: owner Raft user, Raft Server, Gmail address, encrypted refresh token.
- `account_agent_grants`: exact Agent, Server, scopes, enabled state.
- `agent_access_requests`: owner, Server, authenticated Agent ID/name snapshot, requested scopes, reason, and decision state.
- `agent_sessions`: hash of opaque local token, Agent identity, Server, expiry.
- `draft_operations`: idempotency key, request hash, pending/succeeded state, provider draft ID.
- `scheduled_emails`: exact Agent/account/Server, idempotency key and hash, provider draft/message IDs, future time, lifecycle status, and content-free failure metadata.
- `audit_events`: actor, Server, account reference, action, outcome, operation ID, content-free metadata.

Deleting an account cascades its grants, draft-operation metadata, and scheduled jobs. Audit rows keep the event but clear the account foreign key. Deployments must define their own retention, reconciliation, and backup policy.

## Out of scope for v0.1

- hosted multi-tenant operation;
- app-native scheduled monitoring, result inboxes, or channel delivery;
- immediate or arbitrary mail sending outside a previously created scheduled job;
- mailbox state changes other than drafts;
- HTML-composer UI;
- Google OAuth verification on behalf of third-party operators;
- key rotation and owner-facing ambiguous-write reconciliation UI.
