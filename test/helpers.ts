import crypto from "node:crypto";
import type {
  AgentAccessRequest,
  AgentGrant,
  AgentSession,
  AuditEvent,
  AuthorizedAgentAccount,
  DraftOperation,
  GmailAccount,
  GmailGateway,
  Repository
} from "../src/types.js";

export class MemoryRepository implements Repository {
  accounts = new Map<string, GmailAccount>();
  grants = new Map<string, AgentGrant>();
  accessRequests = new Map<string, AgentAccessRequest>();
  sessions = new Map<string, AgentSession>();
  audit: AuditEvent[] = [];
  operations = new Map<string, DraftOperation>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  async upsertGmailAccount(input: Omit<GmailAccount, "id" | "createdAt">) {
    const existing = [...this.accounts.values()].find(
      (item) => item.ownerId === input.ownerId && item.serverId === input.serverId && item.email === input.email
    );
    const account: GmailAccount = {
      id: existing?.id ?? crypto.randomUUID(),
      ...input,
      createdAt: existing?.createdAt ?? this.now().toISOString()
    };
    this.accounts.set(account.id, account);
    return account;
  }

  async listGmailAccounts(ownerId: string, serverId: string) {
    return [...this.accounts.values()].filter((item) => item.ownerId === ownerId && item.serverId === serverId);
  }

  async getGmailAccount(accountId: string) {
    return this.accounts.get(accountId) ?? null;
  }

  async deleteGmailAccount(accountId: string, ownerId: string, serverId: string) {
    const account = this.accounts.get(accountId);
    if (!account || account.ownerId !== ownerId || account.serverId !== serverId) return false;
    this.accounts.delete(accountId);
    for (const key of this.grants.keys()) if (key.startsWith(`${accountId}:`)) this.grants.delete(key);
    return true;
  }

  async putGrant(grant: Omit<AgentGrant, "updatedAt">, ownerId: string) {
    const account = this.accounts.get(grant.accountId);
    if (!account || account.ownerId !== ownerId || account.serverId !== grant.serverId) {
      throw new Error("GMAIL_ACCOUNT_NOT_FOUND");
    }
    const result: AgentGrant = { ...grant, updatedAt: this.now().toISOString() };
    this.grants.set(`${grant.accountId}:${grant.agentId}`, result);
    return result;
  }

  async updateGrant(input: {
    accountId: string;
    agentId: string;
    ownerId: string;
    serverId: string;
    scopes: AgentGrant["scopes"];
    enabled: boolean;
  }) {
    const account = this.accounts.get(input.accountId);
    const key = `${input.accountId}:${input.agentId}`;
    const existing = this.grants.get(key);
    if (!account || account.ownerId !== input.ownerId || account.serverId !== input.serverId ||
        !existing || existing.serverId !== input.serverId) {
      return null;
    }
    const updated: AgentGrant = {
      ...existing,
      scopes: input.scopes,
      enabled: input.enabled,
      updatedAt: this.now().toISOString()
    };
    this.grants.set(key, updated);
    return updated;
  }

  async deleteGrant(accountId: string, agentId: string, ownerId: string, serverId: string) {
    const account = this.accounts.get(accountId);
    if (!account || account.ownerId !== ownerId || account.serverId !== serverId) return false;
    return this.grants.delete(`${accountId}:${agentId}`);
  }

  async getGrant(accountId: string, agentId: string, serverId: string) {
    const grant = this.grants.get(`${accountId}:${agentId}`);
    return grant?.serverId === serverId ? grant : null;
  }

  async listGrants(accountId: string, ownerId: string, serverId: string) {
    const account = this.accounts.get(accountId);
    if (!account || account.ownerId !== ownerId || account.serverId !== serverId) throw new Error("GMAIL_ACCOUNT_NOT_FOUND");
    return [...this.grants.values()].filter((item) => item.accountId === accountId);
  }

  async listAuthorizedAgentAccounts(agentId: string, serverId: string): Promise<AuthorizedAgentAccount[]> {
    return [...this.grants.values()]
      .filter((grant) => grant.agentId === agentId && grant.serverId === serverId && grant.enabled)
      .flatMap((grant) => {
        const account = this.accounts.get(grant.accountId);
        if (!account || account.serverId !== serverId) return [];
        return [{
          accountId: account.id,
          email: account.email,
          ownerId: account.ownerId,
          scopes: grant.scopes,
          status: "active" as const,
          connectedAt: account.createdAt,
          grantUpdatedAt: grant.updatedAt
        }];
      })
      .sort((left, right) => left.accountId.localeCompare(right.accountId));
  }

  async createAccessRequest(
    request: Omit<AgentAccessRequest, "id" | "status" | "createdAt" | "updatedAt" | "decidedAt">
  ) {
    const existing = [...this.accessRequests.values()].find(
      (item) => item.ownerId === request.ownerId && item.serverId === request.serverId &&
        item.agentId === request.agentId && item.status === "pending"
    );
    const timestamp = this.now().toISOString();
    const result: AgentAccessRequest = {
      id: existing?.id ?? crypto.randomUUID(),
      ...request,
      status: "pending",
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp
    };
    this.accessRequests.set(result.id, result);
    return result;
  }

  async listAccessRequests(ownerId: string, serverId: string) {
    return [...this.accessRequests.values()].filter(
      (item) => item.ownerId === ownerId && item.serverId === serverId
    );
  }

  async decideAccessRequest(input: {
    requestId: string;
    ownerId: string;
    serverId: string;
    decision: "approved" | "denied";
    accountIds?: string[];
    scopes?: AgentGrant["scopes"];
  }) {
    const request = this.accessRequests.get(input.requestId);
    if (!request || request.ownerId !== input.ownerId || request.serverId !== input.serverId) {
      throw new Error("ACCESS_REQUEST_NOT_FOUND");
    }
    if (request.status !== "pending") throw new Error("ACCESS_REQUEST_ALREADY_DECIDED");
    const grants: AgentGrant[] = [];
    if (input.decision === "approved") {
      const accountIds = [...new Set(input.accountIds ?? [])];
      const scopes = [...new Set(input.scopes ?? [])];
      if (!accountIds.length || !scopes.length || scopes.some((scope) => !request.requestedScopes.includes(scope))) {
        throw new Error("ACCESS_REQUEST_INVALID_APPROVAL");
      }
      for (const accountId of accountIds) {
        grants.push(await this.putGrant({
          accountId,
          agentId: request.agentId,
          agentName: request.agentName,
          serverId: request.serverId,
          scopes,
          enabled: true
        }, input.ownerId));
      }
    }
    const decided: AgentAccessRequest = {
      ...request,
      status: input.decision,
      updatedAt: this.now().toISOString(),
      decidedAt: this.now().toISOString()
    };
    this.accessRequests.set(decided.id, decided);
    return { request: decided, grants };
  }

  async putAgentSession(session: AgentSession) {
    this.sessions.set(session.tokenHash, session);
  }

  async getAgentSession(tokenHash: string) {
    const session = this.sessions.get(tokenHash);
    return session && new Date(session.expiresAt).getTime() > this.now().getTime() ? session : null;
  }

  async deleteAgentSession(tokenHash: string) {
    this.sessions.delete(tokenHash);
  }

  async appendAudit(event: AuditEvent) {
    this.audit.push(event);
  }

  async beginDraftOperation(operation: DraftOperation) {
    const key = `${operation.accountId}:${operation.agentId}:${operation.operationId}`;
    const existing = this.operations.get(key);
    if (existing) return { created: false, operation: existing };
    this.operations.set(key, operation);
    return { created: true, operation };
  }

  async completeDraftOperation(accountId: string, agentId: string, operationId: string, providerDraftId: string) {
    const key = `${accountId}:${agentId}:${operationId}`;
    const existing = this.operations.get(key);
    if (!existing || existing.status !== "pending") throw new Error("DRAFT_OPERATION_NOT_PENDING");
    const complete: DraftOperation = {
      ...existing,
      status: "succeeded",
      providerDraftId,
      updatedAt: new Date().toISOString()
    };
    this.operations.set(key, complete);
    return complete;
  }
}

export class FakeGmail implements GmailGateway {
  searchCalls = 0;
  readCalls = 0;
  createCalls = 0;
  updateCalls = 0;
  failNextCreate = false;

  async search() {
    this.searchCalls += 1;
    return [{ id: "message-1", threadId: "thread-1" }];
  }

  async read() {
    this.readCalls += 1;
    return { id: "message-1", threadId: "thread-1", labelIds: ["INBOX"], payload: { headers: [] } };
  }

  async createDraft() {
    this.createCalls += 1;
    if (this.failNextCreate) {
      this.failNextCreate = false;
      throw new Error("provider transport failed");
    }
    return { id: `draft-${this.createCalls}`, messageId: `draft-message-${this.createCalls}` };
  }

  async updateDraft(_refreshToken: string, draftId: string) {
    this.updateCalls += 1;
    return { id: draftId, messageId: `updated-${this.updateCalls}` };
  }
}
