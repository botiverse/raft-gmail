import crypto from "node:crypto";
import type {
  AgentAccessRequest,
  AgentGrant,
  AgentSession,
  AuditEvent,
  DraftOperation,
  GmailAccount,
  GrantScope,
  Repository
} from "./types.js";

export interface D1Result<T = Record<string, unknown>> {
  results?: T[];
  success: boolean;
  meta: { changes?: number };
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
}

export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatement;
  batch<T = Record<string, unknown>>(statements: D1PreparedStatement[]): Promise<Array<D1Result<T>>>;
}

type Row = Record<string, unknown>;

function stringValue(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`D1_ROW_INVALID:${key}`);
  return value;
}

function accountFromRow(row: Row): GmailAccount {
  return {
    id: stringValue(row, "id"),
    ownerId: stringValue(row, "owner_raft_user_id"),
    serverId: stringValue(row, "raft_server_id"),
    email: stringValue(row, "email"),
    encryptedRefreshToken: stringValue(row, "encrypted_refresh_token"),
    createdAt: stringValue(row, "created_at")
  };
}

function scopesFromRow(row: Row, key: string): GrantScope[] {
  const parsed = JSON.parse(stringValue(row, key)) as unknown;
  if (!Array.isArray(parsed) || parsed.some((scope) => scope !== "gmail.read" && scope !== "gmail.draft")) {
    throw new Error(`D1_ROW_INVALID:${key}`);
  }
  return parsed as GrantScope[];
}

function grantFromRow(row: Row): AgentGrant {
  return {
    accountId: stringValue(row, "gmail_account_id"),
    agentId: stringValue(row, "raft_agent_id"),
    agentName: stringValue(row, "agent_name"),
    serverId: stringValue(row, "raft_server_id"),
    scopes: scopesFromRow(row, "scopes_json"),
    enabled: Number(row.enabled) === 1,
    updatedAt: stringValue(row, "updated_at")
  };
}

function accessRequestFromRow(row: Row): AgentAccessRequest {
  const decidedAt = row.decided_at;
  return {
    id: stringValue(row, "id"),
    ownerId: stringValue(row, "owner_raft_user_id"),
    serverId: stringValue(row, "raft_server_id"),
    agentId: stringValue(row, "raft_agent_id"),
    agentName: stringValue(row, "agent_name"),
    requestedScopes: scopesFromRow(row, "requested_scopes_json"),
    reason: stringValue(row, "reason"),
    status: stringValue(row, "status") as AgentAccessRequest["status"],
    createdAt: stringValue(row, "created_at"),
    updatedAt: stringValue(row, "updated_at"),
    ...(typeof decidedAt === "string" && decidedAt ? { decidedAt } : {})
  };
}

function sessionFromRow(row: Row): AgentSession {
  return {
    tokenHash: stringValue(row, "token_hash"),
    agentId: stringValue(row, "raft_agent_id"),
    agentName: stringValue(row, "agent_name"),
    serverId: stringValue(row, "raft_server_id"),
    expiresAt: stringValue(row, "expires_at")
  };
}

function draftOperationFromRow(row: Row): DraftOperation {
  const providerDraftId = row.provider_draft_id;
  return {
    accountId: stringValue(row, "gmail_account_id"),
    agentId: stringValue(row, "raft_agent_id"),
    operationId: stringValue(row, "operation_id"),
    action: stringValue(row, "action") as DraftOperation["action"],
    requestHash: stringValue(row, "request_hash"),
    status: stringValue(row, "status") as DraftOperation["status"],
    ...(typeof providerDraftId === "string" && providerDraftId ? { providerDraftId } : {}),
    updatedAt: stringValue(row, "updated_at")
  };
}

function nowIso() {
  return new Date().toISOString();
}

export class D1Repository implements Repository {
  constructor(private readonly database: D1DatabaseLike) {}

  async upsertGmailAccount(input: Omit<GmailAccount, "id" | "createdAt">): Promise<GmailAccount> {
    const timestamp = nowIso();
    const row = await this.database.prepare(
      `INSERT INTO gmail_accounts
         (id, owner_raft_user_id, raft_server_id, email, encrypted_refresh_token, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (owner_raft_user_id, raft_server_id, email)
       DO UPDATE SET encrypted_refresh_token = excluded.encrypted_refresh_token, updated_at = excluded.updated_at
       RETURNING *`
    ).bind(
      crypto.randomUUID(), input.ownerId, input.serverId, input.email, input.encryptedRefreshToken, timestamp, timestamp
    ).first<Row>();
    if (!row) throw new Error("D1_WRITE_FAILED:gmail_accounts");
    return accountFromRow(row);
  }

  async listGmailAccounts(ownerId: string, serverId: string): Promise<GmailAccount[]> {
    const result = await this.database.prepare(
      "SELECT * FROM gmail_accounts WHERE owner_raft_user_id = ? AND raft_server_id = ? ORDER BY email"
    ).bind(ownerId, serverId).all<Row>();
    return (result.results ?? []).map(accountFromRow);
  }

  async getGmailAccount(accountId: string): Promise<GmailAccount | null> {
    const row = await this.database.prepare("SELECT * FROM gmail_accounts WHERE id = ?").bind(accountId).first<Row>();
    return row ? accountFromRow(row) : null;
  }

  async deleteGmailAccount(accountId: string, ownerId: string, serverId: string): Promise<boolean> {
    const result = await this.database.prepare(
      "DELETE FROM gmail_accounts WHERE id = ? AND owner_raft_user_id = ? AND raft_server_id = ?"
    ).bind(accountId, ownerId, serverId).run();
    return (result.meta.changes ?? 0) === 1;
  }

  async putGrant(grant: Omit<AgentGrant, "updatedAt">, ownerId: string): Promise<AgentGrant> {
    const row = await this.database.prepare(
      `INSERT INTO account_agent_grants
         (gmail_account_id, raft_agent_id, agent_name, raft_server_id, scopes_json, enabled, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM gmail_accounts
         WHERE id = ? AND owner_raft_user_id = ? AND raft_server_id = ?
       )
       ON CONFLICT (gmail_account_id, raft_agent_id)
       DO UPDATE SET agent_name = excluded.agent_name, scopes_json = excluded.scopes_json,
         enabled = excluded.enabled, updated_at = excluded.updated_at
       RETURNING *`
    ).bind(
      grant.accountId, grant.agentId, grant.agentName, grant.serverId, JSON.stringify(grant.scopes),
      grant.enabled ? 1 : 0, nowIso(), grant.accountId, ownerId, grant.serverId
    ).first<Row>();
    if (!row) throw new Error("GMAIL_ACCOUNT_NOT_FOUND");
    return grantFromRow(row);
  }

  async updateGrant(input: {
    accountId: string;
    agentId: string;
    ownerId: string;
    serverId: string;
    scopes: GrantScope[];
    enabled: boolean;
  }): Promise<AgentGrant | null> {
    const row = await this.database.prepare(
      `UPDATE account_agent_grants
       SET scopes_json = ?, enabled = ?, updated_at = ?
       WHERE gmail_account_id = ? AND raft_agent_id = ? AND raft_server_id = ?
         AND EXISTS (
           SELECT 1 FROM gmail_accounts
           WHERE id = account_agent_grants.gmail_account_id
             AND owner_raft_user_id = ? AND raft_server_id = ?
         )
       RETURNING *`
    ).bind(
      JSON.stringify(input.scopes), input.enabled ? 1 : 0, nowIso(), input.accountId, input.agentId,
      input.serverId, input.ownerId, input.serverId
    ).first<Row>();
    return row ? grantFromRow(row) : null;
  }

  async deleteGrant(accountId: string, agentId: string, ownerId: string, serverId: string): Promise<boolean> {
    const result = await this.database.prepare(
      `DELETE FROM account_agent_grants
       WHERE gmail_account_id = ? AND raft_agent_id = ?
         AND EXISTS (
           SELECT 1 FROM gmail_accounts
           WHERE id = account_agent_grants.gmail_account_id
             AND owner_raft_user_id = ? AND raft_server_id = ?
         )`
    ).bind(accountId, agentId, ownerId, serverId).run();
    return (result.meta.changes ?? 0) === 1;
  }

  async getGrant(accountId: string, agentId: string, serverId: string): Promise<AgentGrant | null> {
    const row = await this.database.prepare(
      `SELECT * FROM account_agent_grants
       WHERE gmail_account_id = ? AND raft_agent_id = ? AND raft_server_id = ?`
    ).bind(accountId, agentId, serverId).first<Row>();
    return row ? grantFromRow(row) : null;
  }

  async listGrants(accountId: string, ownerId: string, serverId: string): Promise<AgentGrant[]> {
    const account = await this.database.prepare(
      "SELECT id FROM gmail_accounts WHERE id = ? AND owner_raft_user_id = ? AND raft_server_id = ?"
    ).bind(accountId, ownerId, serverId).first<Row>();
    if (!account) throw new Error("GMAIL_ACCOUNT_NOT_FOUND");
    const result = await this.database.prepare(
      "SELECT * FROM account_agent_grants WHERE gmail_account_id = ? ORDER BY raft_agent_id"
    ).bind(accountId).all<Row>();
    return (result.results ?? []).map(grantFromRow);
  }

  async createAccessRequest(
    request: Omit<AgentAccessRequest, "id" | "status" | "createdAt" | "updatedAt" | "decidedAt">
  ): Promise<AgentAccessRequest> {
    const timestamp = nowIso();
    const row = await this.database.prepare(
      `INSERT INTO agent_access_requests
         (id, owner_raft_user_id, raft_server_id, raft_agent_id, agent_name, requested_scopes_json,
          reason, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
       ON CONFLICT (owner_raft_user_id, raft_server_id, raft_agent_id) WHERE status = 'pending'
       DO UPDATE SET agent_name = excluded.agent_name, requested_scopes_json = excluded.requested_scopes_json,
         reason = excluded.reason, updated_at = excluded.updated_at
       RETURNING *`
    ).bind(
      crypto.randomUUID(), request.ownerId, request.serverId, request.agentId, request.agentName,
      JSON.stringify(request.requestedScopes), request.reason, timestamp, timestamp
    ).first<Row>();
    if (!row) throw new Error("D1_WRITE_FAILED:agent_access_requests");
    return accessRequestFromRow(row);
  }

  async listAccessRequests(ownerId: string, serverId: string): Promise<AgentAccessRequest[]> {
    const result = await this.database.prepare(
      `SELECT * FROM agent_access_requests
       WHERE owner_raft_user_id = ? AND raft_server_id = ?
       ORDER BY (status = 'pending') DESC, created_at DESC`
    ).bind(ownerId, serverId).all<Row>();
    return (result.results ?? []).map(accessRequestFromRow);
  }

  async decideAccessRequest(input: {
    requestId: string;
    ownerId: string;
    serverId: string;
    decision: "approved" | "denied";
    accountIds?: string[];
    scopes?: GrantScope[];
  }): Promise<{ request: AgentAccessRequest; grants: AgentGrant[] }> {
    const current = await this.database.prepare(
      `SELECT * FROM agent_access_requests
       WHERE id = ? AND owner_raft_user_id = ? AND raft_server_id = ?`
    ).bind(input.requestId, input.ownerId, input.serverId).first<Row>();
    if (!current) throw new Error("ACCESS_REQUEST_NOT_FOUND");
    const request = accessRequestFromRow(current);
    if (request.status !== "pending") throw new Error("ACCESS_REQUEST_ALREADY_DECIDED");

    const timestamp = nowIso();
    const decisionNonce = crypto.randomUUID();
    const statements: D1PreparedStatement[] = [
      this.database.prepare(
        `UPDATE agent_access_requests
         SET status = ?, decided_at = ?, updated_at = ?, decision_nonce = ?
         WHERE id = ? AND owner_raft_user_id = ? AND raft_server_id = ? AND status = 'pending'`
      ).bind(
        input.decision, timestamp, timestamp, decisionNonce, input.requestId, input.ownerId, input.serverId
      )
    ];

    const accountIds = input.decision === "approved" ? [...new Set(input.accountIds ?? [])] : [];
    const scopes = [...new Set(input.scopes ?? [])];
    if (input.decision === "approved") {
      if (!accountIds.length || !scopes.length || scopes.some((scope) => !request.requestedScopes.includes(scope))) {
        throw new Error("ACCESS_REQUEST_INVALID_APPROVAL");
      }
      const placeholders = accountIds.map(() => "?").join(", ");
      const owned = await this.database.prepare(
        `SELECT id FROM gmail_accounts
         WHERE id IN (${placeholders}) AND owner_raft_user_id = ? AND raft_server_id = ?`
      ).bind(...accountIds, input.ownerId, input.serverId).all<Row>();
      if ((owned.results ?? []).length !== accountIds.length) throw new Error("GMAIL_ACCOUNT_NOT_FOUND");
      for (const accountId of accountIds) {
        statements.push(this.database.prepare(
          `INSERT INTO account_agent_grants
             (gmail_account_id, raft_agent_id, agent_name, raft_server_id, scopes_json, enabled, updated_at)
           SELECT ?, raft_agent_id, agent_name, raft_server_id, ?, 1, ?
           FROM agent_access_requests
           WHERE id = ? AND owner_raft_user_id = ? AND raft_server_id = ?
             AND status = 'approved' AND decision_nonce = ?
           ON CONFLICT (gmail_account_id, raft_agent_id)
           DO UPDATE SET agent_name = excluded.agent_name, scopes_json = excluded.scopes_json,
             enabled = 1, updated_at = excluded.updated_at`
        ).bind(
          accountId, JSON.stringify(scopes), timestamp, input.requestId, input.ownerId, input.serverId, decisionNonce
        ));
      }
    }

    const results = await this.database.batch(statements);
    if ((results[0]?.meta.changes ?? 0) !== 1) throw new Error("ACCESS_REQUEST_ALREADY_DECIDED");
    const decidedRow = await this.database.prepare("SELECT * FROM agent_access_requests WHERE id = ?")
      .bind(input.requestId).first<Row>();
    if (!decidedRow) throw new Error("ACCESS_REQUEST_NOT_FOUND");
    const grants: AgentGrant[] = [];
    for (const accountId of accountIds) {
      const grant = await this.getGrant(accountId, request.agentId, input.serverId);
      if (!grant) throw new Error("D1_WRITE_FAILED:account_agent_grants");
      grants.push(grant);
    }
    return { request: accessRequestFromRow(decidedRow), grants };
  }

  async putAgentSession(session: AgentSession): Promise<void> {
    await this.database.prepare(
      `INSERT INTO agent_sessions (token_hash, raft_agent_id, agent_name, raft_server_id, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (token_hash) DO UPDATE SET expires_at = excluded.expires_at`
    ).bind(
      session.tokenHash, session.agentId, session.agentName, session.serverId, session.expiresAt, nowIso()
    ).run();
  }

  async getAgentSession(tokenHash: string): Promise<AgentSession | null> {
    const row = await this.database.prepare(
      "SELECT * FROM agent_sessions WHERE token_hash = ? AND expires_at > ?"
    ).bind(tokenHash, nowIso()).first<Row>();
    return row ? sessionFromRow(row) : null;
  }

  async deleteAgentSession(tokenHash: string): Promise<void> {
    await this.database.prepare("DELETE FROM agent_sessions WHERE token_hash = ?").bind(tokenHash).run();
  }

  async appendAudit(event: AuditEvent): Promise<void> {
    await this.database.prepare(
      `INSERT INTO audit_events
         (id, occurred_at, actor_type, actor_id, raft_server_id, gmail_account_id,
          action, outcome, operation_id, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      crypto.randomUUID(), nowIso(), event.actorType, event.actorId, event.serverId, event.accountId ?? null,
      event.action, event.outcome, event.operationId ?? null, JSON.stringify(event.metadata ?? {})
    ).run();
  }

  async beginDraftOperation(operation: DraftOperation): Promise<{ created: boolean; operation: DraftOperation }> {
    const result = await this.database.prepare(
      `INSERT OR IGNORE INTO draft_operations
         (gmail_account_id, raft_agent_id, operation_id, action, request_hash, status, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)`
    ).bind(
      operation.accountId, operation.agentId, operation.operationId, operation.action,
      operation.requestHash, operation.updatedAt
    ).run();
    const row = await this.database.prepare(
      `SELECT * FROM draft_operations
       WHERE gmail_account_id = ? AND raft_agent_id = ? AND operation_id = ?`
    ).bind(operation.accountId, operation.agentId, operation.operationId).first<Row>();
    if (!row) throw new Error("D1_WRITE_FAILED:draft_operations");
    return { created: (result.meta.changes ?? 0) === 1, operation: draftOperationFromRow(row) };
  }

  async completeDraftOperation(
    accountId: string,
    agentId: string,
    operationId: string,
    providerDraftId: string
  ): Promise<DraftOperation> {
    const row = await this.database.prepare(
      `UPDATE draft_operations
       SET status = 'succeeded', provider_draft_id = ?, updated_at = ?
       WHERE gmail_account_id = ? AND raft_agent_id = ? AND operation_id = ? AND status = 'pending'
       RETURNING *`
    ).bind(providerDraftId, nowIso(), accountId, agentId, operationId).first<Row>();
    if (!row) throw new Error("DRAFT_OPERATION_NOT_PENDING");
    return draftOperationFromRow(row);
  }
}
