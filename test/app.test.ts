import assert from "node:assert/strict";
import { describe, it } from "node:test";
import request from "supertest";
import { createApp } from "../src/app.js";
import { loadConfig, type Config } from "../src/config.js";
import { createTokenVault } from "../src/crypto.js";
import type { RaftPrincipal } from "../src/types.js";
import { FakeGmail, MemoryRepository } from "./helpers.js";

const config: Config = {
  APP_ORIGIN: "http://localhost:4184",
  PORT: 4184,
  DATABASE_URL: "postgres://unused",
  SESSION_SECRET: "test-session-secret-at-least-thirty-two-characters",
  TOKEN_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 7).toString("base64"),
  AGENT_SESSION_TTL_SECONDS: 3600,
  RAFT_APP_ORIGIN: "https://app.raft.build",
  RAFT_API_ORIGIN: "https://api.raft.build",
  RAFT_SETUP_PATH: "/login-with-raft/setup",
  RAFT_CLIENT_ID: "test-client",
  RAFT_CLIENT_SECRET: "test-secret",
  GOOGLE_CLIENT_ID: "google-client",
  GOOGLE_CLIENT_SECRET: "google-secret"
};

function fixture(
  repository?: MemoryRepository,
  now: () => Date = () => new Date("2026-09-18T00:00:00.000Z")
) {
  repository ??= new MemoryRepository(now);
  const gmail = new FakeGmail();
  let tokenCounter = 0;
  const exchangedRaftCodes = new Set<string>();
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
        if (exchangedRaftCodes.has(code)) throw new Error("RAFT_TOKEN_EXCHANGE_FAILED:409");
        const principal = principals[code];
        if (!principal) throw new Error("unknown code");
        exchangedRaftCodes.add(code);
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
  it("publishes the Raft Agent manifest v0 contract on both registered paths", async () => {
    const { app } = fixture();
    for (const path of ["/.well-known/raft-app-manifest.json", "/.well-known/raft-agent-manifest.json"]) {
      const response = await request(app).get(path).expect(200);
      const manifest = response.body as {
        schema: string;
        service: string;
        execution: { mode: string; base_url: string };
        auth: { type: string; login_url: string };
        actions: Array<{
          name: string;
          endpoint: { method: string; path: string };
          parameters: Record<string, { type: string; required?: boolean }>;
          response?: unknown;
        }>;
      };
      assert.equal(manifest.schema, "raft-agent-manifest.v0");
      assert.equal(manifest.service, config.RAFT_CLIENT_ID);
      assert.deepEqual(manifest.execution, { mode: "http_api", base_url: config.APP_ORIGIN });
      assert.deepEqual(manifest.auth, {
        type: "login_with_raft",
        login_url: `${config.APP_ORIGIN}/auth/raft/login`
      });
      assert.deepEqual(manifest.actions.map((action) => action.name), [
        "gmail-accounts-list",
        "gmail-access-request",
        "gmail-search",
        "gmail-read",
        "gmail-draft-create",
        "gmail-draft-update"
      ]);
      for (const action of manifest.actions) {
        assert.equal(action.endpoint.method, "POST");
        assert.match(action.endpoint.path, /^\/actions\/gmail-/);
        assert.equal(action.response, undefined);
      }
      assert.equal(manifest.actions.some((action) => /send|schedule|delete|archive|mark.?read/i.test(action.name)), false);
    }
  });

  it("establishes a cookie-backed Agent session for stateless CLI handoff and preserves revocation", async () => {
    const { app, repository } = fixture();
    const agent = request.agent(app);
    const callback = await agent.get("/auth/raft/callback?code=agentA").expect(200);
    const setCookies = callback.headers["set-cookie"] as unknown as string[] | undefined;
    assert.ok(setCookies?.some((cookie) => cookie.startsWith("raft_gmail=")));
    assert.equal(callback.body.tokenType, "service-local-agent-session");
    assert.equal(callback.body.rawRaftTokenExposed, false);
    assert.equal(repository.sessions.size, 1);
    assert.deepEqual([...repository.sessions.values()].map(({ agentId, serverId }) => ({ agentId, serverId })), [
      { agentId: "agent-a", serverId: "server-1" }
    ]);

    const authenticated = await agent.post("/actions/gmail-search").send({}).expect(400);
    assert.equal(authenticated.body.error.code, "INVALID_REQUEST");

    await agent.delete("/api/agent/session").expect(200);
    assert.equal(repository.sessions.size, 0);
    const revoked = await agent.post("/actions/gmail-search").send({}).expect(401);
    assert.equal(revoked.body.error.code, "AGENT_SESSION_REQUIRED");
  });

  it("defaults Agent sessions to one hour and rejects them at the exact expiry boundary", async () => {
    assert.equal(loadConfig({
      SESSION_SECRET: config.SESSION_SECRET,
      TOKEN_ENCRYPTION_KEY_BASE64: config.TOKEN_ENCRYPTION_KEY_BASE64,
      RAFT_CLIENT_ID: config.RAFT_CLIENT_ID,
      RAFT_CLIENT_SECRET: config.RAFT_CLIENT_SECRET,
      GOOGLE_CLIENT_ID: config.GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET: config.GOOGLE_CLIENT_SECRET
    }).AGENT_SESSION_TTL_SECONDS, 3600);

    let timestamp = Date.parse("2026-09-18T00:00:00.000Z");
    const now = () => new Date(timestamp);
    const repository = new MemoryRepository(now);
    const { app } = fixture(repository, now);
    const callback = await request(app).get("/auth/raft/callback?code=agentA").expect(200);
    assert.equal(callback.body.expiresAt, "2026-09-18T01:00:00.000Z");

    timestamp += 3_600_000 - 1;
    await request(app)
      .post("/actions/gmail-accounts-list")
      .set("authorization", `Bearer ${callback.body.agentSessionToken}`)
      .send({})
      .expect(200);

    timestamp += 1;
    const expired = await request(app)
      .post("/actions/gmail-accounts-list")
      .set("authorization", `Bearer ${callback.body.agentSessionToken}`)
      .send({})
      .expect(401);
    assert.equal(expired.body.error.code, "AGENT_SESSION_INVALID");
  });

  it("does not create a second Agent session when the one-time Raft code is replayed", async () => {
    const { app, repository } = fixture();
    await request(app).get("/auth/raft/callback?code=agentA").expect(200);
    const replay = await request(app).get("/auth/raft/callback?code=agentA").expect(500);
    assert.equal(replay.body.error.code, "RAFT_TOKEN_EXCHANGE_FAILED");
    assert.equal(repository.sessions.size, 1);
  });

  it("keeps human OAuth state validation ahead of browser session creation", async () => {
    const { app } = fixture();
    const human = request.agent(app);
    await human.get("/auth/raft/login").expect(302);
    const rejected = await human.get("/auth/raft/callback?code=human&state=wrong-state").expect(400);
    assert.equal(rejected.body.error.code, "INVALID_OAUTH_STATE");
    await human.get("/api/session").expect(401);
  });

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

  it("lets an Agent discover only its active same-server account grants without identity or token fields", async () => {
    const { app, repository, gmail } = fixture();
    const vault = createTokenVault(config.TOKEN_ENCRYPTION_KEY_BASE64);
    const active = await repository.upsertGmailAccount({
      ownerId: "human-1",
      serverId: "server-1",
      email: "owner@example.com",
      encryptedRefreshToken: vault.encrypt("active-secret")
    });
    const disabled = await repository.upsertGmailAccount({
      ownerId: "human-1",
      serverId: "server-1",
      email: "disabled@example.com",
      encryptedRefreshToken: vault.encrypt("disabled-secret")
    });
    const otherAgent = await repository.upsertGmailAccount({
      ownerId: "human-1",
      serverId: "server-1",
      email: "other-agent@example.com",
      encryptedRefreshToken: vault.encrypt("other-agent-secret")
    });
    const otherServer = await repository.upsertGmailAccount({
      ownerId: "human-2",
      serverId: "server-2",
      email: "other-server@example.com",
      encryptedRefreshToken: vault.encrypt("other-server-secret")
    });
    await repository.putGrant({
      accountId: active.id,
      agentId: "agent-a",
      agentName: "Agent A",
      serverId: "server-1",
      scopes: ["gmail.read", "gmail.draft"],
      enabled: true
    }, "human-1");
    await repository.putGrant({
      accountId: disabled.id,
      agentId: "agent-a",
      agentName: "Agent A",
      serverId: "server-1",
      scopes: ["gmail.read"],
      enabled: false
    }, "human-1");
    await repository.putGrant({
      accountId: otherAgent.id,
      agentId: "agent-b",
      agentName: "Agent B",
      serverId: "server-1",
      scopes: ["gmail.read"],
      enabled: true
    }, "human-1");
    await repository.putGrant({
      accountId: otherServer.id,
      agentId: "agent-a",
      agentName: "Agent A",
      serverId: "server-2",
      scopes: ["gmail.read"],
      enabled: true
    }, "human-2");

    await request(app).post("/actions/gmail-accounts-list").send({}).expect(401);
    const token = await loginAgent(app, "agentA");
    const listed = await request(app)
      .post("/actions/gmail-accounts-list")
      .set("authorization", `Bearer ${token}`)
      .send({})
      .expect(200);
    assert.deepEqual(listed.body.result, [{
      accountId: active.id,
      scopes: ["gmail.read", "gmail.draft"],
      status: "active",
      connectedAt: "2026-09-18T00:00:00.000Z",
      grantUpdatedAt: "2026-09-18T00:00:00.000Z"
    }]);
    for (const forbidden of ["email", "ownerId", "serverId", "encryptedRefreshToken"]) {
      assert.equal(forbidden in listed.body.result[0], false);
    }
    assert.equal(gmail.searchCalls + gmail.readCalls + gmail.createCalls + gmail.updateCalls, 0);

    assert.equal(await repository.deleteGrant(active.id, "agent-a", "human-1", "server-1"), true);
    const afterRevoke = await request(app)
      .post("/actions/gmail-accounts-list")
      .set("authorization", `Bearer ${token}`)
      .send({})
      .expect(200);
    assert.deepEqual(afterRevoke.body.result, []);
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

    const reused = await request(app)
      .post("/actions/gmail-draft-create")
      .set("authorization", `Bearer ${token}`)
      .send({ ...payload, subject: "A different draft" })
      .expect(409);
    assert.equal(reused.body.error.code, "OPERATION_ID_REUSED");
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
    assert.deepEqual(names, [
      "gmail-accounts-list",
      "gmail-access-request",
      "gmail-search",
      "gmail-read",
      "gmail-draft-create",
      "gmail-draft-update"
    ]);
    assert.equal(names.some((name: string) => name.includes("send")), false);
    await request(app).post("/actions/gmail-send").send({}).expect(404);
  });
});
