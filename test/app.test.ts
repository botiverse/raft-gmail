import assert from "node:assert/strict";
import { describe, it } from "node:test";
import request from "supertest";
import { createApp } from "../src/app.js";
import type { Config } from "../src/config.js";
import { createTokenVault } from "../src/crypto.js";
import type { RaftPrincipal } from "../src/types.js";
import { FakeGmail, MemoryRepository } from "./helpers.js";

const config: Config = {
  APP_ORIGIN: "http://localhost:4184",
  PORT: 4184,
  DATABASE_URL: "postgres://unused",
  SESSION_SECRET: "test-session-secret-at-least-thirty-two-characters",
  TOKEN_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 7).toString("base64"),
  AGENT_SESSION_TTL_SECONDS: 900,
  RAFT_APP_ORIGIN: "https://app.raft.build",
  RAFT_API_ORIGIN: "https://api.raft.build",
  RAFT_SETUP_PATH: "/login-with-raft/setup",
  RAFT_CLIENT_ID: "test-client",
  RAFT_CLIENT_SECRET: "test-secret",
  GOOGLE_CLIENT_ID: "google-client",
  GOOGLE_CLIENT_SECRET: "google-secret"
};

function fixture(repository?: MemoryRepository) {
  const now = () => new Date("2026-09-18T00:00:00.000Z");
  repository ??= new MemoryRepository(now);
  const gmail = new FakeGmail();
  let tokenCounter = 0;
  const principals: Record<string, RaftPrincipal> = {
    human: { type: "human", id: "human-1", name: "Owner", serverId: "server-1" },
    agentA: { type: "agent", id: "agent-a", name: "Agent A", serverId: "server-1" },
    agentB: { type: "agent", id: "agent-b", name: "Agent B", serverId: "server-1" },
    agentOtherServer: { type: "agent", id: "agent-a", name: "Agent A", serverId: "server-2" }
  };
  const app = createApp({
    config,
    repository,
    gmail,
    tokenVault: createTokenVault(config.TOKEN_ENCRYPTION_KEY_BASE64),
    raftIdentity: {
      setupUrl(callbackUrl, state) {
        const url = new URL("https://app.raft.build/login-with-raft/setup");
        url.searchParams.set("return_to", callbackUrl);
        if (state) url.searchParams.set("state", state);
        return url.toString();
      },
      async exchange(code) {
        const principal = principals[code];
        if (!principal) throw new Error("unknown code");
        return principal;
      }
    },
    googleIdentity: {
      authorizationUrl(state) {
        return `https://accounts.google.test/oauth?state=${encodeURIComponent(state)}`;
      },
      async exchange() {
        return { email: "owner@example.com", refreshToken: "google-refresh-token-secret" };
      }
    },
    randomToken: () => `test-token-${++tokenCounter}-abcdefghijklmnopqrstuvwxyz`,
    now
  });
  return { app, repository, gmail };
}

type TestAgent = ReturnType<typeof request.agent>;

async function loginHuman(agent: TestAgent) {
  const start = await agent.get("/auth/raft/login").expect(302);
  assert.ok(start.headers.location);
  const state = new URL(start.headers.location as string).searchParams.get("state");
  assert.ok(state);
  await agent.get(`/auth/raft/callback?code=human&state=${encodeURIComponent(state)}`).expect(302);
}

async function connectGmail(agent: TestAgent) {
  const start = await agent.get("/auth/google/start").expect(302);
  assert.ok(start.headers.location);
  const state = new URL(start.headers.location as string).searchParams.get("state");
  assert.ok(state);
  await agent
    .get(`/auth/google/callback?code=google&state=${encodeURIComponent(state)}`)
    .expect(302)
    .expect("location", "/?connected=1");
  const result = await agent.get("/api/accounts").expect(200);
  return result.body.result[0].id as string;
}

async function csrfToken(agent: TestAgent) {
  const session = await agent.get("/api/session").expect(200);
  assert.equal(typeof session.body.result.csrfToken, "string");
  return session.body.result.csrfToken as string;
}

async function loginAgent(app: ReturnType<typeof createApp>, code: string) {
  const result = await request(app).get(`/auth/raft/callback?code=${code}`).expect(200);
  return result.body.agentSessionToken as string;
}

async function putGrant(repository: MemoryRepository, accountId: string, agentId: string, scopes: Array<"gmail.read" | "gmail.draft">) {
  await repository.putGrant({
    accountId,
    agentId,
    agentName: agentId === "agent-a" ? "Agent A" : agentId,
    serverId: "server-1",
    scopes,
    enabled: true
  }, "human-1");
}

describe("Raft Gmail capability boundary", () => {
  it("connects a human-owned Gmail account without exposing its refresh token", async () => {
    const { app, repository } = fixture();
    const human = request.agent(app);
    await loginHuman(human);
    const accountId = await connectGmail(human);
    const listed = await human.get("/api/accounts").expect(200);
    assert.equal(listed.body.result[0].id, accountId);
    assert.equal(listed.text.includes("google-refresh-token-secret"), false);
    assert.equal(listed.text.includes("encryptedRefreshToken"), false);
  });

  it("requires a session CSRF challenge for human grant mutations", async () => {
    const { app, repository } = fixture();
    const human = request.agent(app);
    await loginHuman(human);
    const accountId = await connectGmail(human);
    const denied = await human
      .put(`/api/accounts/${accountId}/grants/agent-a`)
      .send({ scopes: ["gmail.read"], enabled: true })
      .expect(403);
    assert.equal(denied.body.error.code, "CSRF_TOKEN_INVALID");

    await putGrant(repository, accountId, "agent-a", ["gmail.read"]);
    const csrf = await csrfToken(human);
    await human
      .put(`/api/accounts/${accountId}/grants/agent-a`)
      .set("x-csrf-token", csrf)
      .send({ scopes: ["gmail.read"], enabled: true })
      .expect(200);
  });

  it("requires an authenticated Agent request before a human can create account grants", async () => {
    const { app } = fixture();
    const human = request.agent(app);
    await loginHuman(human);
    const accountId = await connectGmail(human);
    const csrf = await csrfToken(human);

    const blocked = await human
      .put(`/api/accounts/${accountId}/grants/agent-a`)
      .set("x-csrf-token", csrf)
      .send({ scopes: ["gmail.read"], enabled: true })
      .expect(404);
    assert.equal(blocked.body.error.code, "GRANT_NOT_FOUND");

    const instructions = await human.get("/api/access-request-instructions").expect(200);
    const token = await loginAgent(app, "agentA");
    const requested = await request(app)
      .post("/actions/gmail-access-request")
      .set("authorization", `Bearer ${token}`)
      .send({
        ownerRef: instructions.body.result.ownerRef,
        scopes: ["gmail.read", "gmail.draft"],
        reason: "Help triage mail and prepare reply drafts."
      })
      .expect(200);
    assert.equal(requested.body.result.agentName, "Agent A");

    const pending = await human.get("/api/access-requests").expect(200);
    assert.equal(pending.body.result.length, 1);
    assert.equal(pending.body.result[0].agentId, "agent-a");

    const approved = await human
      .post(`/api/access-requests/${requested.body.result.id}/approve`)
      .set("x-csrf-token", csrf)
      .send({ accountIds: [accountId], scopes: ["gmail.read"] })
      .expect(200);
    assert.equal(approved.body.result.grants[0].agentName, "Agent A");
    assert.deepEqual(approved.body.result.grants[0].scopes, ["gmail.read"]);

    await request(app)
      .post("/actions/gmail-search")
      .set("authorization", `Bearer ${token}`)
      .send({ accountId, query: "is:unread" })
      .expect(200);
  });

  it("denies an ungranted Agent and does not reveal whether another server owns the account", async () => {
    const { app, repository } = fixture();
    const account = await repository.upsertGmailAccount({
      ownerId: "human-1",
      serverId: "server-1",
      email: "owner@example.com",
      encryptedRefreshToken: createTokenVault(config.TOKEN_ENCRYPTION_KEY_BASE64).encrypt("secret")
    });
    const sameServerToken = await loginAgent(app, "agentB");
    await request(app)
      .post("/actions/gmail-search")
      .set("authorization", `Bearer ${sameServerToken}`)
      .send({ accountId: account.id, query: "is:unread" })
      .expect(403);

    const otherServerToken = await loginAgent(app, "agentOtherServer");
    const hidden = await request(app)
      .post("/actions/gmail-search")
      .set("authorization", `Bearer ${otherServerToken}`)
      .send({ accountId: account.id, query: "is:unread" })
      .expect(404);
    assert.equal(hidden.body.error.code, "ACCOUNT_NOT_FOUND");
  });

  it("keeps grants account-scoped for the same Agent on the same Server", async () => {
    const { app, repository, gmail } = fixture();
    const vault = createTokenVault(config.TOKEN_ENCRYPTION_KEY_BASE64);
    const first = await repository.upsertGmailAccount({
      ownerId: "human-1",
      serverId: "server-1",
      email: "first@example.com",
      encryptedRefreshToken: vault.encrypt("first-secret")
    });
    const second = await repository.upsertGmailAccount({
      ownerId: "human-1",
      serverId: "server-1",
      email: "second@example.com",
      encryptedRefreshToken: vault.encrypt("second-secret")
    });
    await repository.putGrant(
      { accountId: first.id, agentId: "agent-a", agentName: "Agent A", serverId: "server-1", scopes: ["gmail.read"], enabled: true },
      "human-1"
    );
    const token = await loginAgent(app, "agentA");

    await request(app)
      .post("/actions/gmail-search")
      .set("authorization", `Bearer ${token}`)
      .send({ accountId: first.id, query: "is:inbox" })
      .expect(200);
    await request(app)
      .post("/actions/gmail-search")
      .set("authorization", `Bearer ${token}`)
      .send({ accountId: second.id, query: "is:inbox" })
      .expect(403);
    assert.equal(gmail.searchCalls, 1);
  });

  it("enforces read and draft scopes independently and revokes access immediately", async () => {
    const { app, gmail, repository } = fixture();
    const human = request.agent(app);
    await loginHuman(human);
    const accountId = await connectGmail(human);
    await putGrant(repository, accountId, "agent-a", ["gmail.read"]);
    const token = await loginAgent(app, "agentA");

    await request(app)
      .post("/actions/gmail-search")
      .set("authorization", `Bearer ${token}`)
      .send({ accountId, query: "newer_than:7d" })
      .expect(200);
    assert.equal(gmail.searchCalls, 1);

    await request(app)
      .post("/actions/gmail-draft-create")
      .set("authorization", `Bearer ${token}`)
      .send({ accountId, operationId: "operation-read-only", to: ["a@example.com"], subject: "Hello", bodyText: "Draft" })
      .expect(403);
    assert.equal(gmail.createCalls, 0);

    const csrf = await csrfToken(human);
    await human.delete(`/api/accounts/${accountId}/grants/agent-a`).set("x-csrf-token", csrf).expect(200);
    await request(app)
      .post("/actions/gmail-search")
      .set("authorization", `Bearer ${token}`)
      .send({ accountId, query: "newer_than:7d" })
      .expect(403);
  });

  it("does not recreate a grant when revoke wins a concurrent edit", async () => {
    const repository = new MemoryRepository();
    const originalGetGrant = repository.getGrant.bind(repository);
    const originalUpdateGrant = repository.updateGrant.bind(repository);
    let raceArmed = false;

    // Model the delete-first serialization outcome for both the old
    // read-then-upsert path and the atomic update path. The old path reads the
    // grant, loses it to revoke, then recreates it; the atomic path returns no row.
    repository.getGrant = async (...args) => {
      const existing = await originalGetGrant(...args);
      if (raceArmed && existing) {
        await repository.deleteGrant(args[0], args[1], "human-1", args[2]);
      }
      return existing;
    };
    repository.updateGrant = async (input) => {
      if (raceArmed) {
        await repository.deleteGrant(input.accountId, input.agentId, input.ownerId, input.serverId);
      }
      return originalUpdateGrant(input);
    };

    const { app } = fixture(repository);
    const human = request.agent(app);
    await loginHuman(human);
    const accountId = await connectGmail(human);
    await putGrant(repository, accountId, "agent-a", ["gmail.read"]);
    const csrf = await csrfToken(human);
    raceArmed = true;

    const staleEdit = await human
      .put(`/api/accounts/${accountId}/grants/agent-a`)
      .set("x-csrf-token", csrf)
      .send({ scopes: ["gmail.read", "gmail.draft"], enabled: true })
      .expect(404);
    assert.equal(staleEdit.body.error.code, "GRANT_NOT_FOUND");
    assert.equal(await originalGetGrant(accountId, "agent-a", "server-1"), null);
  });

  it("lets a draft-granted Agent create directly and safely replays the same operation", async () => {
    const { app, gmail, repository } = fixture();
    const human = request.agent(app);
    await loginHuman(human);
    const accountId = await connectGmail(human);
    await putGrant(repository, accountId, "agent-a", ["gmail.draft"]);
    const token = await loginAgent(app, "agentA");
    const payload = {
      accountId,
      operationId: "operation-direct-draft",
      to: ["recipient@example.com"],
      subject: "Draft only",
      bodyText: "This stays in Gmail drafts."
    };

    const created = await request(app)
      .post("/actions/gmail-draft-create")
      .set("authorization", `Bearer ${token}`)
      .send(payload)
      .expect(200);
    assert.equal(created.body.result.replayed, false);
    assert.equal(gmail.createCalls, 1);

    const replayed = await request(app)
      .post("/actions/gmail-draft-create")
      .set("authorization", `Bearer ${token}`)
      .send(payload)
      .expect(200);
    assert.equal(replayed.body.result.replayed, true);
    assert.equal(gmail.createCalls, 1);

    const updated = await request(app)
      .post("/actions/gmail-draft-update")
      .set("authorization", `Bearer ${token}`)
      .send({
        ...payload,
        operationId: "operation-direct-update",
        draftId: created.body.result.id,
        bodyText: "Updated draft body."
      })
      .expect(200);
    assert.equal(updated.body.result.id, created.body.result.id);
    assert.equal(gmail.updateCalls, 1);
  });

  it("holds an ambiguous draft outcome instead of retrying or duplicating", async () => {
    const { app, gmail, repository } = fixture();
    const human = request.agent(app);
    await loginHuman(human);
    const accountId = await connectGmail(human);
    await putGrant(repository, accountId, "agent-a", ["gmail.draft"]);
    const token = await loginAgent(app, "agentA");
    gmail.failNextCreate = true;
    const payload = {
      accountId,
      operationId: "operation-ambiguous-write",
      to: ["recipient@example.com"],
      subject: "Maybe created",
      bodyText: "Reconcile before retry."
    };

    await request(app)
      .post("/actions/gmail-draft-create")
      .set("authorization", `Bearer ${token}`)
      .send(payload)
      .expect(502);
    const held = await request(app)
      .post("/actions/gmail-draft-create")
      .set("authorization", `Bearer ${token}`)
      .send(payload)
      .expect(409);
    assert.equal(held.body.error.code, "OPERATION_OUTCOME_UNKNOWN");
    assert.equal(gmail.createCalls, 1);
  });

  it("has no send action or route in the manifest or HTTP surface", async () => {
    const { app } = fixture();
    const manifest = await request(app).get("/.well-known/raft-app-manifest.json").expect(200);
    const names = manifest.body.actions.map((action: { name: string }) => action.name);
    assert.deepEqual(names, ["gmail-access-request", "gmail-search", "gmail-read", "gmail-draft-create", "gmail-draft-update"]);
    assert.equal(names.some((name: string) => name.includes("send")), false);
    await request(app).post("/actions/gmail-send").send({}).expect(404);
  });
});
