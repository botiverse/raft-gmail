import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { JSDOM } from "jsdom";
import type {
  DashboardApi,
  GrantInput,
  PublicAccessRequest,
  PublicAgentGrant,
  PublicGmailAccount
} from "../src/client/api.js";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
Object.defineProperty(dom.window, "matchMedia", {
  configurable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return false; }
  })
});
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  Event: dom.window.Event,
  MouseEvent: dom.window.MouseEvent,
  MutationObserver: dom.window.MutationObserver,
  getComputedStyle: dom.window.getComputedStyle,
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(callback, 0),
  cancelAnimationFrame: (handle: number) => clearTimeout(handle)
});
Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
Object.defineProperty(globalThis.navigator, "clipboard", {
  configurable: true,
  value: { async writeText() {} }
});

const React = await import("react");
const { render, screen, fireEvent, waitFor, cleanup, within } = await import("@testing-library/react");
const { ThemeProvider } = await import("raft-ui");
const { DashboardApp } = await import("../src/client/App.js");

afterEach(() => cleanup());

function createApi(
  accounts: PublicGmailAccount[],
  initialGrants: PublicAgentGrant[] = [],
  initialRequests: PublicAccessRequest[] = []
) {
  const grants = [...initialGrants];
  const accessRequests = [...initialRequests];
  const writes: Array<{ accountId: string; input: GrantInput }> = [];
  const api: DashboardApi = {
    async getSession() {
      return {
        principal: { type: "human", id: "human-1", name: "Cindy", serverId: "server-1" },
        csrfToken: "csrf-token-abcdefghijklmnopqrstuvwxyz"
      };
    },
    async listAccounts() {
      return accounts;
    },
    async listGrants(accountId) {
      return grants.filter((grant) => grant.accountId === accountId);
    },
    async listAccessRequests() {
      return accessRequests;
    },
    async getAccessRequestInstructions() {
      return { prompt: "Ask this Agent to use ownerRef signed-owner-reference.", ownerRef: "signed-owner-reference", expiresAt: "2026-09-25T00:00:00.000Z" };
    },
    async approveAccessRequest(requestId, accountIds, scopes) {
      const request = accessRequests.find((item) => item.id === requestId)!;
      const decided = { ...request, status: "approved" as const };
      accessRequests.splice(accessRequests.indexOf(request), 1, decided);
      const created = accountIds.map((accountId) => ({
        accountId,
        agentId: request.agentId,
        agentName: request.agentName,
        serverId: "server-1",
        scopes,
        enabled: true,
        updatedAt: "2026-09-18T00:00:00.000Z"
      }));
      grants.push(...created);
      return { request: decided, grants: created };
    },
    async denyAccessRequest(requestId) {
      const request = accessRequests.find((item) => item.id === requestId)!;
      return { ...request, status: "denied" as const };
    },
    async putGrant(accountId, input) {
      writes.push({ accountId, input });
      const grant: PublicAgentGrant = {
        accountId,
        agentId: input.agentId,
        agentName: grants.find((item) => item.agentId === input.agentId)?.agentName ?? "Agent",
        serverId: "server-1",
        scopes: input.scopes,
        enabled: input.enabled,
        updatedAt: "2026-09-18T00:00:00.000Z"
      };
      const index = grants.findIndex((item) => item.accountId === accountId && item.agentId === input.agentId);
      if (index >= 0) grants[index] = grant;
      else grants.push(grant);
      return grant;
    },
    async deleteGrant(accountId, agentId) {
      const index = grants.findIndex((item) => item.accountId === accountId && item.agentId === agentId);
      if (index >= 0) grants.splice(index, 1);
    },
    async deleteAccount() {}
  };
  return { api, writes };
}

function renderDashboard(api: DashboardApi) {
  return render(
    <ThemeProvider defaultTheme="elegant" defaultMode="light">
      <DashboardApp api={api} />
    </ThemeProvider>
  );
}

describe("owner dashboard", () => {
  it("shows account-scoped grants and never exposes a send action", async () => {
    const account = { id: "11111111-1111-4111-8111-111111111111", email: "cindy@example.com", createdAt: "2026-09-18T00:00:00.000Z" };
    const grant: PublicAgentGrant = {
      accountId: account.id,
      agentId: "9c3b3d7f-291a-4a21-862b-37e754186cdf",
      agentName: "John",
      serverId: "server-1",
      scopes: ["gmail.read", "gmail.draft"],
      enabled: true,
      updatedAt: "2026-09-18T00:00:00.000Z"
    };
    const { api } = createApi([account], [grant]);
    renderDashboard(api);

    assert.equal(await screen.findByRole("heading", { name: "Gmail access for your Agents" }).then(Boolean), true);
    assert.equal(screen.getAllByText("cindy@example.com").length >= 2, true);
    assert.equal(screen.getByText("Read mail") !== null, true);
    assert.equal(screen.getByText("Maintain drafts") !== null, true);
    assert.equal(screen.queryByRole("button", { name: /send/i }), null);
    assert.equal(screen.getByText(/Sending mail is not available/i) !== null, true);
  });

  it("explains the request flow and approves an authenticated Agent request", async () => {
    const account = { id: "22222222-2222-4222-8222-222222222222", email: "owner@example.com", createdAt: "2026-09-18T00:00:00.000Z" };
    const pending: PublicAccessRequest = {
      id: "33333333-3333-4333-8333-333333333333",
      agentId: "agent-demo",
      agentName: "Demo Agent",
      requestedScopes: ["gmail.read", "gmail.draft"],
      reason: "Triage the inbox and prepare drafts.",
      status: "pending",
      createdAt: "2026-09-18T00:00:00.000Z"
    };
    const { api } = createApi([account], [], [pending]);
    renderDashboard(api);

    const addButtons = await screen.findAllByRole("button", { name: "Add Agent" });
    fireEvent.click(addButtons[0]!);
    const dialog = await screen.findByRole("dialog");
    assert.equal(dialog.textContent?.includes("authenticated Raft identity"), true, dialog.outerHTML);
    assert.equal(within(dialog).queryByText("Raft Agent ID"), null);
    fireEvent.click(within(dialog).getByRole("button", { name: "Review requests" }));
    fireEvent.click(await screen.findByRole("button", { name: "Review request" }));
    const review = await screen.findByRole("dialog");
    assert.equal(review.textContent?.includes("Demo Agent"), true);
    fireEvent.click(within(review).getByRole("button", { name: "Approve access" }));
    await waitFor(() => assert.equal(screen.queryByRole("button", { name: "Review request" }), null));
  });

  it("shows a connect-first empty state when the owner has no Gmail accounts", async () => {
    const { api } = createApi([]);
    renderDashboard(api);
    assert.equal(await screen.findByText("Connect your first Gmail account").then(Boolean), true);
    assert.equal(screen.getAllByRole("button", { name: "Connect Gmail" }).length > 0, true);
  });
});
