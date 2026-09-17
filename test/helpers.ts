import crypto from "node:crypto";
import type {
  AgentGrant,
  AgentSession,
  AuditEvent,
  DraftOperation,
  GmailAccount,
  GmailGateway,
  Repository
} from "../src/types.js";

export class MemoryRepository implements Repository {
  accounts = new Map<string, GmailAccount>();
  grants = new Map<string, AgentGrant>();
  sessions = new Map<string, AgentSession>();
  audit: AuditEvent[] = [];
  operations = new Map<string, DraftOperation>();

  async upsertGmailAccount(input: Omit<GmailAccount, "id" | "createdAt">) {
    const existing = [...this.accounts.values()].find(
      (item) => item.ownerId === input.ownerId && item.serverId === input.serverId && item.email === input.email
    );
    const account: GmailAccount = {
      id: existing?.id ?? crypto.randomUUID(),
      ...input,
      createdAt: existing?.createdAt ?? new Date().toISOString()
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
    const result: AgentGrant = { ...grant, updatedAt: new Date().toISOString() };
    this.grants.set(`${grant.accountId}:${grant.agentId}`, result);
    return result;
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

  async putAgentSession(session: AgentSession) {
    this.sessions.set(session.tokenHash, session);
  }

  async getAgentSession(tokenHash: string) {
    const session = this.sessions.get(tokenHash);
    return session && new Date(session.expiresAt).getTime() > Date.now() ? session : null;
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
