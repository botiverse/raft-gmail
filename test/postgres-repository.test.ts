import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Pool } from "pg";
import { PostgresRepository } from "../src/postgres-repository.js";

describe("PostgresRepository", () => {
  test("keeps authorized-account discovery scoped to active same-server grants", async () => {
    const queries: Array<{ text: string; values: unknown[] }> = [];
    const pool = {
      async query(text: string, values: unknown[]) {
        queries.push({ text, values });
        return {
          rows: [{
            account_id: "11111111-1111-4111-8111-111111111111",
            email: "owner@example.com",
            owner_id: "owner-1",
            scopes: ["gmail.read", "gmail.draft"],
            connected_at: "2026-09-18T00:00:00.000Z",
            grant_updated_at: "2026-09-18T00:01:00.000Z"
          }]
        };
      }
    } as unknown as Pool;
    const repository = new PostgresRepository(pool);

    assert.deepEqual(await repository.listAuthorizedAgentAccounts("agent-1", "server-1"), [{
      accountId: "11111111-1111-4111-8111-111111111111",
      email: "owner@example.com",
      ownerId: "owner-1",
      scopes: ["gmail.read", "gmail.draft"],
      status: "active",
      connectedAt: "2026-09-18T00:00:00.000Z",
      grantUpdatedAt: "2026-09-18T00:01:00.000Z"
    }]);
    assert.equal(queries.length, 1);
    assert.deepEqual(queries[0]?.values, ["agent-1", "server-1"]);
    assert.match(queries[0]?.text ?? "", /grants\.raft_agent_id = \$1/);
    assert.match(queries[0]?.text ?? "", /grants\.raft_server_id = \$2/);
    assert.match(queries[0]?.text ?? "", /accounts\.raft_server_id = \$2/);
    assert.match(queries[0]?.text ?? "", /grants\.enabled = true/);
    assert.match(queries[0]?.text ?? "", /accounts\.email/);
    assert.match(queries[0]?.text ?? "", /accounts\.owner_raft_user_id AS owner_id/);
    assert.doesNotMatch(queries[0]?.text ?? "", /encrypted_refresh_token/);
  });
});
