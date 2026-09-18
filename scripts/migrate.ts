import { readFile } from "node:fs/promises";
import { glob } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import { loadConfig } from "../src/config.js";

const config = loadConfig();
const pool = new Pool({ connectionString: config.DATABASE_URL });

try {
  for await (const file of glob("migrations/*.sql")) {
    const sql = await readFile(path.resolve(file), "utf8");
    await pool.query(sql);
    process.stdout.write(`applied ${file}\n`);
  }
} finally {
  await pool.end();
}
