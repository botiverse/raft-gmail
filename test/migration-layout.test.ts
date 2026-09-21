import assert from "node:assert/strict";
import { glob, readFile } from "node:fs/promises";
import { describe, test } from "node:test";
import { POSTGRES_MIGRATIONS_GLOB } from "../scripts/migration-paths.js";

async function discover(pattern: string) {
  const files: string[] = [];
  for await (const file of glob(pattern)) files.push(file.replaceAll("\\", "/"));
  return files.sort();
}

describe("database migration layout", () => {
  test("keeps the PostgreSQL and D1 runners on disjoint migration sets", async () => {
    const wrangler = JSON.parse(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8")) as {
      d1_databases?: Array<{ binding?: string; migrations_dir?: string }>;
    };
    const d1Binding = wrangler.d1_databases?.find((database) => database.binding === "DB");

    assert.equal(d1Binding?.migrations_dir, "migrations/d1");
    const postgresFiles = await discover(POSTGRES_MIGRATIONS_GLOB);
    const d1Files = await discover(`${d1Binding.migrations_dir}/*.sql`);
    assert.deepEqual(postgresFiles, ["migrations/postgres/0001_initial.sql"]);
    assert.deepEqual(d1Files, ["migrations/d1/0001_initial.sql"]);
    assert.deepEqual(await discover("migrations/*.sql"), []);

    const postgresSql = await readFile(postgresFiles[0]!, "utf8");
    const d1Sql = await readFile(d1Files[0]!, "utf8");
    assert.match(postgresSql, /CREATE EXTENSION IF NOT EXISTS pgcrypto/);
    assert.doesNotMatch(postgresSql, /PRAGMA foreign_keys/);
    assert.match(d1Sql, /PRAGMA foreign_keys = ON/);
    assert.doesNotMatch(d1Sql, /CREATE EXTENSION/);
  });
});
