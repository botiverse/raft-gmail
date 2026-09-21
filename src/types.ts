export const grantScopes = ["gmail.read", "gmail.draft"] as const;
export type GrantScope = (typeof grantScopes)[number];

export type PrincipalType = "human" | "agent";

export interface RaftPrincipal {
  type: PrincipalType;
  id: string;
  name: string;
  serverId: string;
}

export interface GmailAccount {
  id: string;
  ownerId: string;
  serverId: string;
  email: string;
  encryptedRefreshToken: string;
  createdAt: string;
}

export interface AgentGrant {
  accountId: string;
  agentId: string;
  agentName: string;
  serverId: string;
  scopes: GrantScope[];
  enabled: boolean;
  updatedAt: string;
}

export interface AuthorizedAgentAccount {
  accountId: string;
  email: string;
  ownerId: string;
  scopes: GrantScope[];
  status: "active";
  connectedAt: string;
  grantUpdatedAt: string;
}

export type AccessRequestStatus = "pending" | "approved" | "denied";

export interface AgentAccessRequest {
  id: string;
  ownerId: string;
  serverId: string;
  agentId: string;
  agentName: string;
  requestedScopes: GrantScope[];
  reason: string;
  status: AccessRequestStatus;
  createdAt: string;
  updatedAt: string;
  decidedAt?: string;
}

export interface AgentSession {
  tokenHash: string;
  agentId: string;
  agentName: string;
  serverId: string;
  expiresAt: string;
}

export interface AuditEvent {
  actorType: PrincipalType;
  actorId: string;
  serverId: string;
  accountId?: string;
  action: string;
  outcome: "allowed" | "denied" | "succeeded" | "failed";
  operationId?: string;
  metadata?: Record<string, unknown>;
}

export interface DraftOperation {
  accountId: string;
  agentId: string;
  operationId: string;
  action: "gmail.draft.create" | "gmail.draft.update";
  requestHash: string;
  status: "pending" | "succeeded";
  providerDraftId?: string;
  updatedAt: string;
}

export interface Repository {
  upsertGmailAccount(input: Omit<GmailAccount, "id" | "createdAt">): Promise<GmailAccount>;
  listGmailAccounts(ownerId: string, serverId: string): Promise<GmailAccount[]>;
  getGmailAccount(accountId: string): Promise<GmailAccount | null>;
  deleteGmailAccount(accountId: string, ownerId: string, serverId: string): Promise<boolean>;
  putGrant(grant: Omit<AgentGrant, "updatedAt">, ownerId: string): Promise<AgentGrant>;
  updateGrant(input: {
    accountId: string;
    agentId: string;
    ownerId: string;
    serverId: string;
    scopes: GrantScope[];
    enabled: boolean;
  }): Promise<AgentGrant | null>;
  deleteGrant(accountId: string, agentId: string, ownerId: string, serverId: string): Promise<boolean>;
  getGrant(accountId: string, agentId: string, serverId: string): Promise<AgentGrant | null>;
  listGrants(accountId: string, ownerId: string, serverId: string): Promise<AgentGrant[]>;
  listAuthorizedAgentAccounts(agentId: string, serverId: string): Promise<AuthorizedAgentAccount[]>;
  createAccessRequest(
    request: Omit<AgentAccessRequest, "id" | "status" | "createdAt" | "updatedAt" | "decidedAt">
  ): Promise<AgentAccessRequest>;
  listAccessRequests(ownerId: string, serverId: string): Promise<AgentAccessRequest[]>;
  decideAccessRequest(input: {
    requestId: string;
    ownerId: string;
    serverId: string;
    decision: "approved" | "denied";
    accountIds?: string[];
    scopes?: GrantScope[];
  }): Promise<{ request: AgentAccessRequest; grants: AgentGrant[] }>;
  putAgentSession(session: AgentSession): Promise<void>;
  getAgentSession(tokenHash: string): Promise<AgentSession | null>;
  deleteAgentSession(tokenHash: string): Promise<void>;
  appendAudit(event: AuditEvent): Promise<void>;
  beginDraftOperation(operation: DraftOperation): Promise<{ created: boolean; operation: DraftOperation }>;
  completeDraftOperation(
    accountId: string,
    agentId: string,
    operationId: string,
    providerDraftId: string
  ): Promise<DraftOperation>;
}

export interface GmailSearchResult {
  id: string;
  threadId: string;
}

export interface GmailMessageResult {
  id: string;
  threadId: string;
  labelIds: string[];
  payload: unknown;
}

export interface DraftInput {
  to: string[];
  cc?: string[];
  subject: string;
  bodyText: string;
  threadId?: string;
}

export interface GmailGateway {
  search(refreshToken: string, query: string, maxResults: number): Promise<GmailSearchResult[]>;
  read(refreshToken: string, messageId: string): Promise<GmailMessageResult>;
  createDraft(refreshToken: string, input: DraftInput): Promise<{ id: string; messageId?: string }>;
  updateDraft(refreshToken: string, draftId: string, input: DraftInput): Promise<{ id: string; messageId?: string }>;
}
