import { resolve } from "node:path";
import { Pool } from "pg";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createTokenVault } from "./crypto.js";
import { createGmailGateway } from "./gmail.js";
import { createGoogleIdentityProvider, createRaftIdentityProvider } from "./identity.js";
import { PostgresRepository } from "./postgres-repository.js";

const config = loadConfig();
const pool = new Pool({ connectionString: config.DATABASE_URL });
const app = createApp({
  config,
  repository: new PostgresRepository(pool),
  tokenVault: createTokenVault(config.TOKEN_ENCRYPTION_KEY_BASE64),
  raftIdentity: createRaftIdentityProvider(config),
  googleIdentity: createGoogleIdentityProvider(config),
  gmail: createGmailGateway(config),
  clientDistPath: resolve(process.cwd(), "dist/client")
});

const server = app.listen(config.PORT, () => {
  process.stdout.write(`Raft Gmail listening on ${config.APP_ORIGIN}\n`);
});

async function shutdown() {
  server.close();
  await pool.end();
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
