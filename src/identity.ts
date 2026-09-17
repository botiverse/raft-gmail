import { Buffer } from "node:buffer";
import { google } from "googleapis";
import type { Config } from "./config.js";
import type { RaftPrincipal } from "./types.js";

export interface RaftIdentityProvider {
  setupUrl(callbackUrl: string, state?: string): string;
  exchange(code: string, callbackUrl: string): Promise<RaftPrincipal>;
}

export interface GoogleIdentityProvider {
  authorizationUrl(state: string): string;
  exchange(code: string): Promise<{ email: string; refreshToken: string }>;
}

export function createRaftIdentityProvider(config: Config): RaftIdentityProvider {
  return {
    setupUrl(callbackUrl, state) {
      const url = new URL(config.RAFT_SETUP_PATH, config.RAFT_APP_ORIGIN);
      url.searchParams.set("client_id", config.RAFT_CLIENT_ID);
      url.searchParams.set("return_to", callbackUrl);
      url.searchParams.set("scope", "openid profile identity");
      if (state) url.searchParams.set("state", state);
      return url.toString();
    },
    async exchange(code, callbackUrl) {
      const tokenResponse = await fetch(`${config.RAFT_API_ORIGIN}/api/oauth/token`, {
        method: "POST",
        headers: {
          authorization: `Basic ${Buffer.from(`${config.RAFT_CLIENT_ID}:${config.RAFT_CLIENT_SECRET}`).toString("base64")}`,
          "content-type": "application/x-www-form-urlencoded"
        },
        body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: callbackUrl })
      });
      if (!tokenResponse.ok) throw new Error(`RAFT_TOKEN_EXCHANGE_FAILED:${tokenResponse.status}`);
      const token = (await tokenResponse.json()) as { access_token?: string };
      if (!token.access_token) throw new Error("RAFT_TOKEN_EXCHANGE_MISSING_ACCESS_TOKEN");

      const userinfoResponse = await fetch(`${config.RAFT_API_ORIGIN}/api/oauth/userinfo`, {
        headers: { authorization: `Bearer ${token.access_token}` }
      });
      if (!userinfoResponse.ok) throw new Error(`RAFT_USERINFO_FAILED:${userinfoResponse.status}`);
      const raw = (await userinfoResponse.json()) as Record<string, unknown>;
      return normalizeRaftPrincipal(raw);
    }
  };
}

function normalizeRaftPrincipal(raw: Record<string, unknown>): RaftPrincipal {
  const rawType = raw.type ?? raw.principal_type ?? raw.principalType;
  const type = rawType === "agent" ? "agent" : rawType === "human" || rawType === "user" ? "human" : null;
  const id = String(raw.sub ?? raw.id ?? "");
  const name = String(raw.name ?? raw.preferred_username ?? raw.login ?? id);
  const serverId = String(raw.server_id ?? raw.serverId ?? "");
  if (!type || !id || !serverId) throw new Error("RAFT_USERINFO_INVALID_PRINCIPAL");
  return { type, id, name, serverId };
}

export function createGoogleIdentityProvider(config: Config): GoogleIdentityProvider {
  const callbackUrl = `${config.APP_ORIGIN}/auth/google/callback`;
  const client = new google.auth.OAuth2(config.GOOGLE_CLIENT_ID, config.GOOGLE_CLIENT_SECRET, callbackUrl);
  return {
    authorizationUrl(state) {
      return client.generateAuthUrl({
        access_type: "offline",
        prompt: "consent",
        state,
        scope: ["openid", "email", "https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.compose"]
      });
    },
    async exchange(code) {
      const { tokens } = await client.getToken(code);
      if (!tokens.refresh_token) throw new Error("GOOGLE_REFRESH_TOKEN_MISSING");
      client.setCredentials(tokens);
      const oauth2 = google.oauth2({ version: "v2", auth: client });
      const profile = await oauth2.userinfo.get();
      if (!profile.data.email) throw new Error("GOOGLE_EMAIL_MISSING");
      if (profile.data.verified_email !== true) throw new Error("GOOGLE_EMAIL_NOT_VERIFIED");
      return { email: profile.data.email, refreshToken: tokens.refresh_token };
    }
  };
}
