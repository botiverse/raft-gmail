import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, test } from "node:test";
import type { D1DatabaseLike, D1PreparedStatement, D1Result } from "../src/d1-repository.js";
import { createLazyD1Database } from "../src/worker-bindings.js";

function statement(): D1PreparedStatement {
  const result: D1Result = { success: true, meta: { changes: 0 } };
  return {
    bind() {
      return this;
    },
    async first<T>() {
      return null as T | null;
    },
    async all<T>() {
      return result as D1Result<T>;
    },
    async run<T>() {
      return result as D1Result<T>;
    }
  };
}

describe("Cloudflare Worker D1 binding", () => {
  test("does not resolve the binding until repository work begins", async () => {
    const prepared = statement();
    const batchResult: D1Result[] = [{ success: true, meta: { changes: 1 } }];
    let database: D1DatabaseLike | undefined;
    let resolutions = 0;
    const lazyDatabase = createLazyD1Database(() => {
      resolutions += 1;
      return database;
    });

    assert.equal(resolutions, 0);
    assert.throws(() => lazyDatabase.prepare("SELECT 1"), /Cloudflare D1 binding DB is required/);
    assert.equal(resolutions, 1);

    database = {
      prepare(query) {
        assert.equal(query, "SELECT 1");
        return prepared;
      },
      async batch<T = Record<string, unknown>>() {
        return batchResult as D1Result<T>[];
      }
    };

    assert.equal(lazyDatabase.prepare("SELECT 1"), prepared);
    assert.equal(resolutions, 2);
    assert.equal(await lazyDatabase.batch([prepared]), batchResult);
    assert.equal(resolutions, 2);
  });

  test("keeps the Worker entrypoint on the lazy binding adapter", async () => {
    const source = await readFile(new URL("../src/worker.ts", import.meta.url), "utf8");

    assert.match(source, /createLazyD1Database\(\(\) => env\.DB as D1DatabaseLike \| undefined\)/);
    assert.doesNotMatch(source, /const database = env\.DB/);
  });

  test("pins the production Agent session TTL to one hour", async () => {
    const source = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");

    assert.match(source, /"AGENT_SESSION_TTL_SECONDS"\s*:\s*"3600"/);
    assert.match(source, /"database_name"\s*:\s*"raft-gmail"/);
  });
});
