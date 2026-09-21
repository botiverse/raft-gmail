import type { D1DatabaseLike, D1PreparedStatement } from "./d1-repository.js";

export function createLazyD1Database(
  resolveDatabase: () => D1DatabaseLike | undefined
): D1DatabaseLike {
  let database: D1DatabaseLike | undefined;

  function requireDatabase(): D1DatabaseLike {
    database ??= resolveDatabase();
    if (!database) throw new Error("Cloudflare D1 binding DB is required.");
    return database;
  }

  return {
    prepare(query: string): D1PreparedStatement {
      return requireDatabase().prepare(query);
    },
    batch<T = Record<string, unknown>>(statements: D1PreparedStatement[]) {
      return requireDatabase().batch<T>(statements);
    }
  };
}
