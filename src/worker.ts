import { httpServerHandler } from "cloudflare:node";
import { env } from "cloudflare:workers";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createTokenVault } from "./crypto.js";
import { D1Repository, type D1DatabaseLike } from "./d1-repository.js";
import { createGmailGateway } from "./gmail.js";
import { createGoogleIdentityProvider, createRaftIdentityProvider } from "./identity.js";
import { processDueScheduledEmails } from "./scheduler.js";
import { createLazyD1Database } from "./worker-bindings.js";

const config = loadConfig();
const database = createLazyD1Database(() => env.DB as D1DatabaseLike | undefined);

const repository = new D1Repository(database);
const tokenVault = createTokenVault(config.TOKEN_ENCRYPTION_KEY_BASE64);
const gmail = createGmailGateway(config);

const app = createApp({
  config,
  repository,
  tokenVault,
  raftIdentity: createRaftIdentityProvider(config),
  googleIdentity: createGoogleIdentityProvider(config),
  gmail
});

app.listen(3000);

const handler = httpServerHandler({ port: 3000 });

export default {
  fetch: handler.fetch,
  scheduled(
    _controller: unknown,
    _workerEnv: unknown,
    context: { waitUntil(promise: Promise<unknown>): void }
  ) {
    context.waitUntil(processDueScheduledEmails({ repository, gmail, tokenVault }));
  }
};
