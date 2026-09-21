import type { Pool, PoolClient, QueryResultRow } from "pg";
import type {
  AgentAccessRequest,
  AgentGrant,
  AgentSession,
  AuditEvent,
  AuthorizedAgentAccount,
  DraftOperation,
  GmailAccount,
  Repository
} from "./types.js";

function accountFromRow(row: QueryResultRow): GmailAccount {
  return {
    id: row.id,
    ownerId: row.owner_raft_user_id,
    serverId: row.raft_server_id,
    email: row.email,
    encryptedRefreshToken: row.encrypted_refresh_token,
    createdAt: new Date(row.created_at).toISOString()
  };
}

function grantFromRow(row: QueryResultRow): AgentGrant {
  return {
    accountId: row.gmail_account_id,
    agentId: row.raft_agent_id,
    agentName: row.agent_name,
    serverId: row.raft_server_id,
    scopes: row.scopes,
    enabled: row.enabled,
    updatedAt: new Date(row.updated_at).toISOString()
  };
}

function accessRequestFromRow(row: QueryResultRow): AgentAccessRequest {
  return {
    id: row.id,
    ownerId: row.owner_raft_user_id,
    serverId: row.raft_server_id,
    agentId: row.raft_agent_id,
    agentName: row.agent_name,
    requestedScopes: row.requested_scopes,
    reason: row.reason,
    status: row.status,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    ...(row.decided_at ? { decidedAt: new Date(row.decided_at).toISOString() } : {})
  };
}

export class PostgresRepository implements Repository {
  constructor(private readonly pool: Pool) {}

  async upsertGmailAccount(input: Omit<GmailAccount, "id" | "createdAt">): Promise<GmailAccount> {
    const result = await this.pool.query(
      `INSERT INTO gmail_accounts
         (owner_raft_user_id, raft_server_id, email, encrypted_refresh_token)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (owner_raft_user_id, raft_server_id, email)
       DO UPDATE SET encrypted_refresh_token = EXCLUDED.encrypted_refresh_token, updated_at = now()
       RETURNING *`,
      [input.ownerId, input.serverId, input.email, input.encryptedRefreshToken]
    );
    return accountFromRow(result.rows[0]);
  }

  async listGmailAccounts(ownerId: string, serverId: string): Promise<GmailAccount[]> {
    const result = await this.pool.query(
      "SELECT * FROM gmail_accounts WHERE owner_raft_user_id = $1 AND raft_server_id = $2 ORDER BY email",
      [ownerId, serverId]
    );
    return result.rows.map(accountFromRow);
  }

  async getGmailAccount(accountId: string): Promise<GmailAccount | null> {
    const result = await this.pool.query("SELECT * FROM gmail_accounts WHERE id = $1", [accountId]);
    return result.rows[0] ? accountFromRow(result.rows[0]) : null;
  }

  async deleteGmailAccount(accountId: string, ownerId: string, serverId: string): Promise<boolean> {
    const result = await this.pool.query(
      "DELETE FROM gmail_accounts WHERE id = $1 AND owner_raft_user_id = $2 AND raft_server_id = $3",
      [accountId, ownerId, serverId]
    );
    return (result.rowCount ?? 0) === 1;
  }

  async putGrant(grant: Omit<AgentGrant, "updatedAt">, ownerId: string): Promise<AgentGrant> {
    return this.withOwnedAccount(grant.accountId, ownerId, grant.serverId, async (client) => {
      const result = await client.query(
        `INSERT INTO account_agent_grants
           (gmail_account_id, raft_agent_id, agent_name, raft_server_id, scopes, enabled)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (gmail_account_id, raft_agent_id)
         DO UPDATE SET agent_name = EXCLUDED.agent_name, scopes = EXCLUDED.scopes,
           enabled = EXCLUDED.enabled, updated_at = now()
         RETURNING *`,
        [grant.accountId, grant.agentId, grant.agentName, grant.serverId, grant.scopes, grant.enabled]
      );
      return grantFromRow(result.rows[0]);
    });
  }

  async updateGrant(input: {
    accountId: string;
    agentId: string;
    ownerId: string;
    serverId: string;
    scopes: AgentGrant["scopes"];
    enabled: boolean;
  }): Promise<AgentGrant | null> {
    const result = await this.pool.query(
      `UPDATE account_agent_grants AS grants
       SET scopes = $5, enabled = $6, updated_at = now()
       FROM gmail_accounts AS accounts
       WHERE grants.gmail_account_id = $1
         AND grants.raft_agent_id = $2
         AND accounts.id = grants.gmail_account_id
         AND accounts.owner_raft_user_id = $3
         AND accounts.raft_server_id = $4
         AND grants.raft_server_id = $4
       RETURNING grants.*`,
      [input.accountId, input.agentId, input.ownerId, input.serverId, input.scopes, input.enabled]
    );
    return result.rows[0] ? grantFromRow(result.rows[0]) : null;
  }

  async deleteGrant(accountId: string, agentId: string, ownerId: string, serverId: string): Promise<boolean> {
    return this.withOwnedAccount(accountId, ownerId, serverId, async (client) => {
      const result = await client.query(
        "DELETE FROM account_agent_grants WHERE gmail_account_id = $1 AND raft_agent_id = $2",
        [accountId, agentId]
      );
      return (result.rowCount ?? 0) === 1;
    });
  }

  async getGrant(accountId: string, agentId: string, serverId: string): Promise<AgentGrant | null> {
    const result = await this.pool.query(
      `SELECT * FROM account_agent_grants
       WHERE gmail_account_id = $1 AND raft_agent_id = $2 AND raft_server_id = $3`,
      [accountId, agentId, serverId]
    );
    return result.rows[0] ? grantFromRow(result.rows[0]) : null;
  }

  async listGrants(accountId: string, ownerId: string, serverId: string): Promise<AgentGrant[]> {
    return this.withOwnedAccount(accountId, ownerId, serverId, async (client) => {
      const result = await client.query(
        "SELECT * FROM account_agent_grants WHERE gmail_account_id = $1 ORDER BY raft_agent_id",
        [accountId]
      );
      return result.rows.map(grantFromRow);
    });
  }

  async listAuthorizedAgentAccounts(agentId: string, serverId: string): Promise<AuthorizedAgentAccount[]> {
    const result = await this.pool.query(
      `SELECT accounts.id AS account_id,
              grants.scopes,
              accounts.created_at AS connected_at,
              grants.updated_at AS grant_updated_at
       FROM account_agent_grants AS grants
       INNER JOIN gmail_accounts AS accounts ON accounts.id = grants.gmail_account_id
       WHERE grants.raft_agent_id = $1
         AND grants.raft_server_id = $2
         AND accounts.raft_server_id = $2
         AND grants.enabled = true
       ORDER BY accounts.id`,
      [agentId, serverId]
    );
    return result.rows.map((row) => ({
      accountId: row.account_id,
      scopes: row.scopes,
      status: "active" as const,
      connectedAt: new Date(row.connected_at).toISOString(),
      grantUpdatedAt: new Date(row.grant_updated_at).toISOString()
    }));
  }

  async createAccessRequest(
    request: Omit<AgentAccessRequest, "id" | "status" | "createdAt" | "updatedAt" | "decidedAt">
  ): Promise<AgentAccessRequest> {
    const result = await this.pool.query(
      `INSERT INTO agent_access_requests
         (owner_raft_user_id, raft_server_id, raft_agent_id, agent_name, requested_scopes, reason)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (owner_raft_user_id, raft_server_id, raft_agent_id) WHERE status = 'pending'
       DO UPDATE SET agent_name = EXCLUDED.agent_name, requested_scopes = EXCLUDED.requested_scopes,
         reason = EXCLUDED.reason, updated_at = now()
       RETURNING *`,
      [request.ownerId, request.serverId, request.agentId, request.agentName, request.requestedScopes, request.reason]
    );
    return accessRequestFromRow(result.rows[0]);
  }

  async listAccessRequests(ownerId: string, serverId: string): Promise<AgentAccessRequest[]> {
    const result = await this.pool.query(
      `SELECT * FROM agent_access_requests
       WHERE owner_raft_user_id = $1 AND raft_server_id = $2
       ORDER BY (status = 'pending') DESC, created_at DESC`,
      [ownerId, serverId]
    );
    return result.rows.map(accessRequestFromRow);
  }

  async decideAccessRequest(input: {
    requestId: string;
    ownerId: string;
    serverId: string;
    decision: "approved" | "denied";
    accountIds?: string[];
    scopes?: AgentGrant["scopes"];
  }): Promise<{ request: AgentAccessRequest; grants: AgentGrant[] }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const requestResult = await client.query(
        `SELECT * FROM agent_access_requests
         WHERE id = $1 AND owner_raft_user_id = $2 AND raft_server_id = $3 FOR UPDATE`,
        [input.requestId, input.ownerId, input.serverId]
      );
      const row = requestResult.rows[0];
      if (!row) throw new Error("ACCESS_REQUEST_NOT_FOUND");
      if (row.status !== "pending") throw new Error("ACCESS_REQUEST_ALREADY_DECIDED");

      const grants: AgentGrant[] = [];
      if (input.decision === "approved") {
        const accountIds = [...new Set(input.accountIds ?? [])];
        const scopes = [...new Set(input.scopes ?? [])];
        if (!accountIds.length || !scopes.length || scopes.some((scope) => !row.requested_scopes.includes(scope))) {
          throw new Error("ACCESS_REQUEST_INVALID_APPROVAL");
        }
        const owned = await client.query(
          `SELECT id FROM gmail_accounts
           WHERE id = ANY($1::uuid[]) AND owner_raft_user_id = $2 AND raft_server_id = $3 FOR UPDATE`,
          [accountIds, input.ownerId, input.serverId]
        );
        if (owned.rowCount !== accountIds.length) throw new Error("GMAIL_ACCOUNT_NOT_FOUND");
        for (const accountId of accountIds) {
          const inserted = await client.query(
            `INSERT INTO account_agent_grants
               (gmail_account_id, raft_agent_id, agent_name, raft_server_id, scopes, enabled)
             VALUES ($1, $2, $3, $4, $5, true)
             ON CONFLICT (gmail_account_id, raft_agent_id)
             DO UPDATE SET agent_name = EXCLUDED.agent_name, scopes = EXCLUDED.scopes,
               enabled = true, updated_at = now()
             RETURNING *`,
            [accountId, row.raft_agent_id, row.agent_name, input.serverId, scopes]
          );
          grants.push(grantFromRow(inserted.rows[0]));
        }
      }

      const decided = await client.query(
        `UPDATE agent_access_requests SET status = $2, decided_at = now(), updated_at = now()
         WHERE id = $1 RETURNING *`,
        [input.requestId, input.decision]
      );
      await client.query("COMMIT");
      return { request: accessRequestFromRow(decided.rows[0]), grants };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async putAgentSession(session: AgentSession): Promise<void> {
    await this.pool.query(
      `INSERT INTO agent_sessions (token_hash, raft_agent_id, agent_name, raft_server_id, expires_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (token_hash) DO UPDATE SET expires_at = EXCLUDED.expires_at`,
      [session.tokenHash, session.agentId, session.agentName, session.serverId, session.expiresAt]
    );
  }

  async getAgentSession(tokenHash: string): Promise<AgentSession | null> {
    const result = await this.pool.query(
      `SELECT * FROM agent_sessions WHERE token_hash = $1 AND expires_at > now()`,
      [tokenHash]
    );
    const row = result.rows[0];
    return row
      ? {
          tokenHash: row.token_hash,
          agentId: row.raft_agent_id,
          agentName: row.agent_name,
          serverId: row.raft_server_id,
          expiresAt: new Date(row.expires_at).toISOString()
        }
      : null;
  }

  async deleteAgentSession(tokenHash: string): Promise<void> {
    await this.pool.query("DELETE FROM agent_sessions WHERE token_hash = $1", [tokenHash]);
  }

  async appendAudit(event: AuditEvent): Promise<void> {
    await this.pool.query(
      `INSERT INTO audit_events
         (actor_type, actor_id, raft_server_id, gmail_account_id, action, outcome, operation_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        event.actorType,
        event.actorId,
        event.serverId,
        event.accountId ?? null,
        event.action,
        event.outcome,
        event.operationId ?? null,
        event.metadata ?? {}
      ]
    );
  }

  async beginDraftOperation(operation: DraftOperation): Promise<{ created: boolean; operation: DraftOperation }> {
    const result = await this.pool.query(
      `INSERT INTO draft_operations
         (gmail_account_id, raft_agent_id, operation_id, action, request_hash, status, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'pending', $6)
       ON CONFLICT (gmail_account_id, raft_agent_id, operation_id) DO NOTHING
       RETURNING *`,
      [
        operation.accountId,
        operation.agentId,
        operation.operationId,
        operation.action,
        operation.requestHash,
        operation.updatedAt
      ]
    );
    const created = Boolean(result.rows[0]);
    const row =
      result.rows[0] ??
      (
        await this.pool.query(
          `SELECT * FROM draft_operations
           WHERE gmail_account_id = $1 AND raft_agent_id = $2 AND operation_id = $3`,
          [operation.accountId, operation.agentId, operation.operationId]
        )
      ).rows[0];
    return { created, operation: draftOperationFromRow(row) };
  }

  async completeDraftOperation(
    accountId: string,
    agentId: string,
    operationId: string,
    providerDraftId: string
  ): Promise<DraftOperation> {
    const result = await this.pool.query(
      `UPDATE draft_operations
       SET status = 'succeeded', provider_draft_id = $4, updated_at = now()
       WHERE gmail_account_id = $1 AND raft_agent_id = $2 AND operation_id = $3 AND status = 'pending'
       RETURNING *`,
      [accountId, agentId, operationId, providerDraftId]
    );
    if (!result.rows[0]) throw new Error("DRAFT_OPERATION_NOT_PENDING");
    return draftOperationFromRow(result.rows[0]);
  }

  private async withOwnedAccount<T>(
    accountId: string,
    ownerId: string | undefined,
    serverId: string,
    callback: (client: PoolClient) => Promise<T>
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const values = ownerId ? [accountId, ownerId, serverId] : [accountId, serverId];
      const ownerClause = ownerId
        ? "id = $1 AND owner_raft_user_id = $2 AND raft_server_id = $3"
        : "id = $1 AND raft_server_id = $2";
      const account = await client.query(`SELECT id FROM gmail_accounts WHERE ${ownerClause} FOR UPDATE`, values);
      if (!account.rowCount) throw new Error("GMAIL_ACCOUNT_NOT_FOUND");
      const result = await callback(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

function draftOperationFromRow(row: QueryResultRow): DraftOperation {
  return {
    accountId: row.gmail_account_id,
    agentId: row.raft_agent_id,
    operationId: row.operation_id,
    action: row.action,
    requestHash: row.request_hash,
    status: row.status,
    ...(row.provider_draft_id ? { providerDraftId: row.provider_draft_id } : {}),
    updatedAt: new Date(row.updated_at).toISOString()
  };
}
