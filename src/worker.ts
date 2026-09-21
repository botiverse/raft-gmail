import { httpServerHandler } from "cloudflare:node";
import { env } from "cloudflare:workers";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createTokenVault } from "./crypto.js";
import { D1Repository, type D1DatabaseLike } from "./d1-repository.js";
import { createGmailGateway } from "./gmail.js";
import { createGoogleIdentityProvider, createRaftIdentityProvider } from "./identity.js";
import { createLazyD1Database } from "./worker-bindings.js";

const config = loadConfig();
const database = createLazyD1Database(() => env.DB as D1DatabaseLike | undefined);

const app = createApp({
  config,
  repository: new D1Repository(database),
  tokenVault: createTokenVault(config.TOKEN_ENCRYPTION_KEY_BASE64),
  raftIdentity: createRaftIdentityProvider(config),
  googleIdentity: createGoogleIdentityProvider(config),
  gmail: createGmailGateway(config)
});

app.listen(3000);

export default httpServerHandler({ port: 3000 });
