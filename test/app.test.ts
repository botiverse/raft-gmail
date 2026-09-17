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
  RAFT_APP_ORIGIN: "https://app.raft.build",
  RAFT_API_ORIGIN: "https://api.raft.build",
  RAFT_SETUP_PATH: "/login-with-raft/setup",
  RAFT_CLIENT_ID: "test-client",
  RAFT_CLIENT_SECRET: "test-secret",
  GOOGLE_CLIENT_ID: "google-client",
  GOOGLE_CLIENT_SECRET: "google-secret"
};

function fixture() {
  const repository = new MemoryRepository();
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
    now: () => new Date("2026-09-18T00:00:00.000Z")
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
  const result = await agent.get(`/auth/google/callback?code=google&state=${encodeURIComponent(state)}`).expect(200);
  return result.body.result.id as string;
}

async function csrfToken(agent: TestAgent) {
  const session = await agent.get("/api/session").expect(200);
  assert.equal(typeof session.body.csrfToken, "string");
  return session.body.csrfToken as string;
}

async function loginAgent(app: ReturnType<typeof createApp>, code: string) {
  const result = await request(app).get(`/auth/raft/agent/callback?code=${code}`).expect(200);
  return result.body.agentSessionToken as string;
}

async function putGrant(agent: TestAgent, accountId: string, agentId: string, scopes: string[]) {
  const csrf = await csrfToken(agent);
  await agent
    .put(`/api/accounts/${accountId}/grants/${agentId}`)
    .set("x-csrf-token", csrf)
    .send({ scopes, enabled: true })
    .expect(200);
}

describe("Raft Gmail capability boundary", () => {
  it("connects a human-owned Gmail account without exposing its refresh token", async () => {
    const { app } = fixture();
    const human = request.agent(app);
    await loginHuman(human);
    const accountId = await connectGmail(human);
    const listed = await human.get("/api/accounts").expect(200);
    assert.equal(listed.body.result[0].id, accountId);
    assert.equal(listed.text.includes("google-refresh-token-secret"), false);
    assert.equal(listed.text.includes("encryptedRefreshToken"), false);
  });

  it("requires a session CSRF challenge for human grant mutations", async () => {
    const { app } = fixture();
    const human = request.agent(app);
    await loginHuman(human);
    const accountId = await connectGmail(human);
    const denied = await human
      .put(`/api/accounts/${accountId}/grants/agent-a`)
      .send({ scopes: ["gmail.read"], enabled: true })
      .expect(403);
    assert.equal(denied.body.error.code, "CSRF_TOKEN_INVALID");

    await putGrant(human, accountId, "agent-a", ["gmail.read"]);
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

  it("enforces read and draft scopes independently and revokes access immediately", async () => {
    const { app, gmail } = fixture();
    const human = request.agent(app);
    await loginHuman(human);
    const accountId = await connectGmail(human);
    await putGrant(human, accountId, "agent-a", ["gmail.read"]);
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

  it("lets a draft-granted Agent create directly and safely replays the same operation", async () => {
    const { app, gmail } = fixture();
    const human = request.agent(app);
    await loginHuman(human);
    const accountId = await connectGmail(human);
    await putGrant(human, accountId, "agent-a", ["gmail.draft"]);
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
  });

  it("holds an ambiguous draft outcome instead of retrying or duplicating", async () => {
    const { app, gmail } = fixture();
    const human = request.agent(app);
    await loginHuman(human);
    const accountId = await connectGmail(human);
    await putGrant(human, accountId, "agent-a", ["gmail.draft"]);
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
    assert.deepEqual(names, ["gmail-search", "gmail-read", "gmail-draft-create", "gmail-draft-update"]);
    assert.equal(names.some((name: string) => name.includes("send")), false);
    await request(app).post("/actions/gmail-send").send({}).expect(404);
  });
});
