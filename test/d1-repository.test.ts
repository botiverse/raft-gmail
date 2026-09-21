import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, test } from "node:test";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import {
  D1Repository,
  type D1DatabaseLike,
  type D1PreparedStatement,
  type D1Result
} from "../src/d1-repository.js";

class SqliteD1Statement implements D1PreparedStatement {
  private values: unknown[] = [];

  constructor(private readonly statement: StatementSync) {}

  bind(...values: unknown[]) {
    this.values = values;
    return this;
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    return (this.statement.get(...(this.values as never[])) as T | undefined) ?? null;
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return { results: this.statement.all(...(this.values as never[])) as T[], success: true, meta: {} };
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const result = this.statement.run(...(this.values as never[]));
    return { results: [], success: true, meta: { changes: Number(result.changes) } };
  }

  runSync<T = Record<string, unknown>>(): D1Result<T> {
    const result = this.statement.run(...(this.values as never[]));
    return { results: [], success: true, meta: { changes: Number(result.changes) } };
  }
}

class SqliteD1Database implements D1DatabaseLike {
  constructor(private readonly database: DatabaseSync) {}

  prepare(query: string): D1PreparedStatement {
    return new SqliteD1Statement(this.database.prepare(query));
  }

  async batch<T = Record<string, unknown>>(statements: D1PreparedStatement[]): Promise<Array<D1Result<T>>> {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => {
        assert.ok(statement instanceof SqliteD1Statement);
        return statement.runSync<T>();
      });
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

describe("D1Repository", () => {
  let database: DatabaseSync;
  let repository: D1Repository;

  beforeEach(() => {
    database = new DatabaseSync(":memory:");
    database.exec(readFileSync(new URL("../migrations/0001_d1.sql", import.meta.url), "utf8"));
    repository = new D1Repository(new SqliteD1Database(database));
  });

  afterEach(() => database.close());

  test("keeps account and grant ownership scoped to the Raft owner and server", async () => {
    const account = await repository.upsertGmailAccount({
      ownerId: "owner-1",
      serverId: "server-1",
      email: "owner@example.com",
      encryptedRefreshToken: "encrypted"
    });
    const grant = await repository.putGrant({
      accountId: account.id,
      agentId: "agent-1",
      agentName: "Dian",
      serverId: "server-1",
      scopes: ["gmail.read"],
      enabled: true
    }, "owner-1");
    assert.deepEqual(grant.scopes, ["gmail.read"]);
    await assert.rejects(
      repository.putGrant({ ...grant, scopes: ["gmail.read", "gmail.draft"] }, "other-owner"),
      /GMAIL_ACCOUNT_NOT_FOUND/
    );
    assert.equal(await repository.updateGrant({
      accountId: account.id,
      agentId: "agent-1",
      ownerId: "other-owner",
      serverId: "server-1",
      scopes: ["gmail.draft"],
      enabled: true
    }), null);
    assert.deepEqual((await repository.getGrant(account.id, "agent-1", "server-1"))?.scopes, ["gmail.read"]);
  });

  test("allows exactly one concurrent access-request decision", async () => {
    const account = await repository.upsertGmailAccount({
      ownerId: "owner-1",
      serverId: "server-1",
      email: "owner@example.com",
      encryptedRefreshToken: "encrypted"
    });
    const request = await repository.createAccessRequest({
      ownerId: "owner-1",
      serverId: "server-1",
      agentId: "agent-1",
      agentName: "Dian",
      requestedScopes: ["gmail.read", "gmail.draft"],
      reason: "Manage Cindy's Gmail"
    });
    const results = await Promise.allSettled([
      repository.decideAccessRequest({
        requestId: request.id,
        ownerId: "owner-1",
        serverId: "server-1",
        decision: "approved",
        accountIds: [account.id],
        scopes: ["gmail.read"]
      }),
      repository.decideAccessRequest({
        requestId: request.id,
        ownerId: "owner-1",
        serverId: "server-1",
        decision: "denied"
      })
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    const finalRequest = (await repository.listAccessRequests("owner-1", "server-1"))[0];
    assert.ok(finalRequest);
    const grant = await repository.getGrant(account.id, "agent-1", "server-1");
    assert.equal(Boolean(grant), finalRequest.status === "approved");
  });

  test("rejects approving an account owned by another Raft user without creating a grant", async () => {
    const foreignAccount = await repository.upsertGmailAccount({
      ownerId: "owner-2",
      serverId: "server-1",
      email: "other-owner@example.com",
      encryptedRefreshToken: "encrypted"
    });
    const accessRequest = await repository.createAccessRequest({
      ownerId: "owner-1",
      serverId: "server-1",
      agentId: "agent-1",
      agentName: "Dian",
      requestedScopes: ["gmail.read"],
      reason: "Manage Cindy's Gmail"
    });

    await assert.rejects(
      repository.decideAccessRequest({
        requestId: accessRequest.id,
        ownerId: "owner-1",
        serverId: "server-1",
        decision: "approved",
        accountIds: [foreignAccount.id],
        scopes: ["gmail.read"]
      }),
      /GMAIL_ACCOUNT_NOT_FOUND/
    );
    assert.equal(await repository.getGrant(foreignAccount.id, "agent-1", "server-1"), null);
    assert.equal((await repository.listAccessRequests("owner-1", "server-1"))[0]?.status, "pending");
  });

  test("pins grants to the winning concurrent approval nonce", async () => {
    const firstAccount = await repository.upsertGmailAccount({
      ownerId: "owner-1",
      serverId: "server-1",
      email: "first@example.com",
      encryptedRefreshToken: "encrypted"
    });
    const secondAccount = await repository.upsertGmailAccount({
      ownerId: "owner-1",
      serverId: "server-1",
      email: "second@example.com",
      encryptedRefreshToken: "encrypted"
    });
    const accessRequest = await repository.createAccessRequest({
      ownerId: "owner-1",
      serverId: "server-1",
      agentId: "agent-1",
      agentName: "Dian",
      requestedScopes: ["gmail.read"],
      reason: "Manage Cindy's Gmail"
    });
    const accountIds = [firstAccount.id, secondAccount.id];

    const results = await Promise.allSettled(accountIds.map((accountId) =>
      repository.decideAccessRequest({
        requestId: accessRequest.id,
        ownerId: "owner-1",
        serverId: "server-1",
        decision: "approved",
        accountIds: [accountId],
        scopes: ["gmail.read"]
      })
    ));

    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    const winnerIndex = results.findIndex((result) => result.status === "fulfilled");
    const loserIndex = winnerIndex === 0 ? 1 : 0;
    assert.ok(await repository.getGrant(accountIds[winnerIndex]!, "agent-1", "server-1"));
    assert.equal(await repository.getGrant(accountIds[loserIndex]!, "agent-1", "server-1"), null);
  });

  test("does not recreate a deleted grant through a later edit", async () => {
    const account = await repository.upsertGmailAccount({
      ownerId: "owner-1",
      serverId: "server-1",
      email: "owner@example.com",
      encryptedRefreshToken: "encrypted"
    });
    await repository.putGrant({
      accountId: account.id,
      agentId: "agent-1",
      agentName: "Dian",
      serverId: "server-1",
      scopes: ["gmail.read"],
      enabled: true
    }, "owner-1");
    assert.equal(await repository.deleteGrant(account.id, "agent-1", "owner-1", "server-1"), true);
    assert.equal(await repository.updateGrant({
      accountId: account.id,
      agentId: "agent-1",
      ownerId: "owner-1",
      serverId: "server-1",
      scopes: ["gmail.read", "gmail.draft"],
      enabled: true
    }), null);
    assert.equal(await repository.getGrant(account.id, "agent-1", "server-1"), null);
  });

  test("keeps draft operations replay-safe", async () => {
    const operation = {
      accountId: "2fa7472a-9424-4f0c-b512-8f026b7c85eb",
      agentId: "agent-1",
      operationId: "operation-1",
      action: "gmail.draft.create" as const,
      requestHash: "hash-1",
      status: "pending" as const,
      updatedAt: new Date().toISOString()
    };
    const account = await repository.upsertGmailAccount({
      ownerId: "owner-1",
      serverId: "server-1",
      email: "owner@example.com",
      encryptedRefreshToken: "encrypted"
    });
    operation.accountId = account.id;
    assert.equal((await repository.beginDraftOperation(operation)).created, true);
    assert.equal((await repository.beginDraftOperation({ ...operation, requestHash: "different" })).created, false);
    const completed = await repository.completeDraftOperation(account.id, "agent-1", "operation-1", "draft-1");
    assert.equal(completed.status, "succeeded");
    assert.equal(completed.providerDraftId, "draft-1");
    await assert.rejects(
      repository.completeDraftOperation(account.id, "agent-1", "operation-1", "draft-2"),
      /DRAFT_OPERATION_NOT_PENDING/
    );
  });
});
