export type GrantScope = "gmail.read" | "gmail.draft";

export interface HumanPrincipal {
  type: "human";
  id: string;
  name: string;
  serverId: string;
}

export interface OwnerSession {
  principal: HumanPrincipal;
  csrfToken: string;
}

export interface PublicGmailAccount {
  id: string;
  email: string;
  createdAt: string;
}

export interface PublicAgentGrant {
  accountId: string;
  agentId: string;
  agentName: string;
  serverId: string;
  scopes: GrantScope[];
  enabled: boolean;
  updatedAt: string;
}

export interface PublicAccessRequest {
  id: string;
  agentId: string;
  agentName: string;
  requestedScopes: GrantScope[];
  reason: string;
  status: "pending" | "approved" | "denied";
  createdAt: string;
}

export interface AccessRequestInstructions {
  prompt: string;
  ownerRef: string;
  expiresAt: string;
}

export interface GrantInput {
  agentId: string;
  scopes: GrantScope[];
  enabled: boolean;
}

export interface DashboardApi {
  getSession(): Promise<OwnerSession>;
  listAccounts(): Promise<PublicGmailAccount[]>;
  listGrants(accountId: string): Promise<PublicAgentGrant[]>;
  listAccessRequests(): Promise<PublicAccessRequest[]>;
  getAccessRequestInstructions(): Promise<AccessRequestInstructions>;
  approveAccessRequest(
    requestId: string,
    accountIds: string[],
    scopes: GrantScope[],
    csrfToken: string
  ): Promise<{ request: PublicAccessRequest; grants: PublicAgentGrant[] }>;
  denyAccessRequest(requestId: string, csrfToken: string): Promise<PublicAccessRequest>;
  putGrant(accountId: string, input: GrantInput, csrfToken: string): Promise<PublicAgentGrant>;
  deleteGrant(accountId: string, agentId: string, csrfToken: string): Promise<void>;
  deleteAccount(accountId: string, csrfToken: string): Promise<void>;
}

export class DashboardApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

type Envelope<T> = { ok: true; result: T } | { ok: false; error?: { code?: string; message?: string } };

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers
    }
  });
  const body = (await response.json().catch(() => null)) as Envelope<T> | null;
  if (!response.ok || !body || body.ok !== true) {
    const failure = body && body.ok === false ? body.error : undefined;
    throw new DashboardApiError(
      response.status,
      failure?.code ?? "REQUEST_FAILED",
      failure?.message ?? "The request could not be completed."
    );
  }
  return body.result;
}

export const dashboardApi: DashboardApi = {
  async getSession() {
    const response = await requestJson<{ principal: HumanPrincipal; csrfToken: string }>("/api/session");
    return response;
  },

  listAccounts() {
    return requestJson<PublicGmailAccount[]>("/api/accounts");
  },

  listGrants(accountId) {
    return requestJson<PublicAgentGrant[]>(`/api/accounts/${encodeURIComponent(accountId)}/grants`);
  },

  listAccessRequests() {
    return requestJson<PublicAccessRequest[]>("/api/access-requests");
  },

  getAccessRequestInstructions() {
    return requestJson<AccessRequestInstructions>("/api/access-request-instructions");
  },

  approveAccessRequest(requestId, accountIds, scopes, csrfToken) {
    return requestJson(`/api/access-requests/${encodeURIComponent(requestId)}/approve`, {
      method: "POST",
      headers: { "x-csrf-token": csrfToken },
      body: JSON.stringify({ accountIds, scopes })
    });
  },

  denyAccessRequest(requestId, csrfToken) {
    return requestJson(`/api/access-requests/${encodeURIComponent(requestId)}/deny`, {
      method: "POST",
      headers: { "x-csrf-token": csrfToken }
    });
  },

  putGrant(accountId, input, csrfToken) {
    return requestJson<PublicAgentGrant>(
      `/api/accounts/${encodeURIComponent(accountId)}/grants/${encodeURIComponent(input.agentId)}`,
      {
        method: "PUT",
        headers: { "x-csrf-token": csrfToken },
        body: JSON.stringify({ scopes: input.scopes, enabled: input.enabled })
      }
    );
  },

  async deleteGrant(accountId, agentId, csrfToken) {
    await requestJson<{ deleted: true }>(
      `/api/accounts/${encodeURIComponent(accountId)}/grants/${encodeURIComponent(agentId)}`,
      { method: "DELETE", headers: { "x-csrf-token": csrfToken } }
    );
  },

  async deleteAccount(accountId, csrfToken) {
    await requestJson<{ deleted: true }>(`/api/accounts/${encodeURIComponent(accountId)}`, {
      method: "DELETE",
      headers: { "x-csrf-token": csrfToken }
    });
  }
};
