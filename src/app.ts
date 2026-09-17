import crypto from "node:crypto";
import cookieSession from "cookie-session";
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import type { Config } from "./config.js";
import { hashOpaqueToken, type TokenVault } from "./crypto.js";
import type { GoogleIdentityProvider, RaftIdentityProvider } from "./identity.js";
import { buildManifest } from "./manifest.js";
import {
  grantScopes,
  type AgentSession,
  type DraftInput,
  type GmailAccount,
  type GmailGateway,
  type GrantScope,
  type RaftPrincipal,
  type Repository
} from "./types.js";

declare module "express-serve-static-core" {
  interface Request {
    agentSession?: AgentSession;
  }
}

interface AppDependencies {
  config: Config;
  repository: Repository;
  tokenVault: TokenVault;
  raftIdentity: RaftIdentityProvider;
  googleIdentity: GoogleIdentityProvider;
  gmail: GmailGateway;
  now?: () => Date;
  randomToken?: () => string;
}

const grantSchema = z.object({
  scopes: z.array(z.enum(grantScopes)).min(1).transform((items) => [...new Set(items)]),
  enabled: z.boolean().default(true)
});

const accountSchema = z.object({ accountId: z.uuid() });
const operationSchema = z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const addressSchema = z.email().max(320);
const draftInputSchema = z.object({
  accountId: z.uuid(),
  operationId: operationSchema,
  to: z.array(addressSchema).min(1).max(50),
  cc: z.array(addressSchema).max(50).optional(),
  subject: z.string().max(998).refine(noHeaderBreaks, "subject must not contain a line break"),
  bodyText: z.string().max(2_000_000),
  threadId: z.string().min(1).max(256).optional()
});

const updateDraftSchema = draftInputSchema.extend({ draftId: z.string().min(1).max(256) });

export function createApp(dependencies: AppDependencies) {
  const { config, repository, tokenVault, raftIdentity, googleIdentity, gmail } = dependencies;
  const now = dependencies.now ?? (() => new Date());
  const randomToken = dependencies.randomToken ?? (() => crypto.randomBytes(32).toString("base64url"));
  const app = express();

  app.disable("x-powered-by");
  app.use(express.json({ limit: "2.2mb" }));
  app.use(
    cookieSession({
      name: "raft_gmail",
      secret: config.SESSION_SECRET,
      httpOnly: true,
      sameSite: "lax",
      secure: config.APP_ORIGIN.startsWith("https://")
    })
  );

  app.get("/healthz", (_req, res) => res.json({ ok: true }));
  app.get("/.well-known/raft-app-manifest.json", (_req, res) => res.json(buildManifest(config.APP_ORIGIN)));
  app.get("/.well-known/raft-agent-manifest.json", (_req, res) => res.json(buildManifest(config.APP_ORIGIN)));

  app.get("/auth/raft/login", (req, res) => {
    const state = randomToken();
    req.session = { raftLoginState: state };
    res.redirect(raftIdentity.setupUrl(`${config.APP_ORIGIN}/auth/raft/callback`, state));
  });

  app.get("/auth/raft/callback", asyncRoute(async (req, res) => {
    const code = requiredQuery(req, "code");
    const state = requiredQuery(req, "state");
    if (!req.session?.raftLoginState || state !== req.session.raftLoginState) {
      return sendError(res, 400, "INVALID_OAUTH_STATE", "Raft login state is missing or invalid.");
    }
    const principal = await raftIdentity.exchange(code, `${config.APP_ORIGIN}/auth/raft/callback`);
    if (principal.type !== "human") {
      req.session = null;
      return sendError(res, 403, "HUMAN_REQUIRED", "This callback requires a Raft human identity.");
    }
    req.session = { principal };
    res.redirect("/");
  }));

  app.get("/auth/raft/agent/callback", asyncRoute(async (req, res) => {
    const code = requiredQuery(req, "code");
    const principal = await raftIdentity.exchange(code, `${config.APP_ORIGIN}/auth/raft/agent/callback`);
    if (principal.type !== "agent") {
      return sendError(res, 403, "AGENT_REQUIRED", "This callback requires a Raft Agent identity.");
    }
    const token = randomToken();
    const expiresAt = new Date(now().getTime() + 12 * 60 * 60 * 1000).toISOString();
    await repository.putAgentSession({
      tokenHash: hashOpaqueToken(token),
      agentId: principal.id,
      agentName: principal.name,
      serverId: principal.serverId,
      expiresAt
    });
    res.json({
      ok: true,
      agentSessionToken: token,
      tokenType: "service-local-agent-session",
      expiresAt,
      principal,
      rawRaftTokenExposed: false
    });
  }));

  app.delete("/api/agent/session", requireAgentSession(repository), asyncRoute(async (req, res) => {
    const token = bearerToken(req);
    await repository.deleteAgentSession(hashOpaqueToken(token));
    res.json({ ok: true, result: { revoked: true } });
  }));

  app.get("/auth/google/start", requireHuman, (req, res) => {
    const state = randomToken();
    req.session = { ...req.session, googleOauthState: state };
    res.redirect(googleIdentity.authorizationUrl(state));
  });

  app.get("/auth/google/callback", requireHuman, asyncRoute(async (req, res) => {
    const code = requiredQuery(req, "code");
    const state = requiredQuery(req, "state");
    if (!req.session?.googleOauthState || state !== req.session.googleOauthState) {
      return sendError(res, 400, "INVALID_OAUTH_STATE", "Google OAuth state is missing or invalid.");
    }
    const principal = humanPrincipal(req);
    const connected = await googleIdentity.exchange(code);
    const account = await repository.upsertGmailAccount({
      ownerId: principal.id,
      serverId: principal.serverId,
      email: connected.email,
      encryptedRefreshToken: tokenVault.encrypt(connected.refreshToken)
    });
    await repository.appendAudit({
      actorType: "human",
      actorId: principal.id,
      serverId: principal.serverId,
      accountId: account.id,
      action: "gmail.account.connect",
      outcome: "succeeded"
    });
    req.session = { principal };
    res.json({ ok: true, result: publicAccount(account) });
  }));

  app.get("/api/session", (req, res) => {
    const principal = req.session?.principal as RaftPrincipal | undefined;
    if (!principal) return sendError(res, 401, "SESSION_REQUIRED", "Login with Raft is required.");
    res.json({ ok: true, principal });
  });

  app.get("/api/accounts", requireHuman, asyncRoute(async (req, res) => {
    const principal = humanPrincipal(req);
    const accounts = await repository.listGmailAccounts(principal.id, principal.serverId);
    res.json({ ok: true, result: accounts.map(publicAccount) });
  }));

  app.delete("/api/accounts/:accountId", requireHuman, asyncRoute(async (req, res) => {
    const { accountId } = accountSchema.parse(req.params);
    const principal = humanPrincipal(req);
    const deleted = await repository.deleteGmailAccount(accountId, principal.id, principal.serverId);
    if (!deleted) return sendError(res, 404, "ACCOUNT_NOT_FOUND", "Gmail account not found.");
    await repository.appendAudit({
      actorType: "human",
      actorId: principal.id,
      serverId: principal.serverId,
      action: "gmail.account.disconnect",
      outcome: "succeeded"
    });
    res.json({ ok: true, result: { deleted: true } });
  }));

  app.get("/api/accounts/:accountId/grants", requireHuman, asyncRoute(async (req, res) => {
    const { accountId } = accountSchema.parse(req.params);
    const principal = humanPrincipal(req);
    const grants = await repository.listGrants(accountId, principal.id, principal.serverId);
    res.json({ ok: true, result: grants });
  }));

  app.put("/api/accounts/:accountId/grants/:agentId", requireHuman, asyncRoute(async (req, res) => {
    const { accountId } = accountSchema.parse(req.params);
    const agentId = z.string().min(1).max(256).parse(req.params.agentId);
    const body = grantSchema.parse(req.body);
    const principal = humanPrincipal(req);
    const account = await repository.getGmailAccount(accountId);
    if (!isOwnedAccount(account, principal)) return sendError(res, 404, "ACCOUNT_NOT_FOUND", "Gmail account not found.");
    const grant = await repository.putGrant({
      accountId,
      agentId,
      serverId: principal.serverId,
      scopes: body.scopes,
      enabled: body.enabled
    }, principal.id);
    await repository.appendAudit({
      actorType: "human",
      actorId: principal.id,
      serverId: principal.serverId,
      accountId,
      action: "gmail.grant.put",
      outcome: "succeeded",
      metadata: { agentId, scopes: body.scopes, enabled: body.enabled }
    });
    res.json({ ok: true, result: grant });
  }));

  app.delete("/api/accounts/:accountId/grants/:agentId", requireHuman, asyncRoute(async (req, res) => {
    const { accountId } = accountSchema.parse(req.params);
    const agentId = z.string().min(1).max(256).parse(req.params.agentId);
    const principal = humanPrincipal(req);
    const deleted = await repository.deleteGrant(accountId, agentId, principal.id, principal.serverId);
    if (!deleted) return sendError(res, 404, "GRANT_NOT_FOUND", "Agent grant not found.");
    await repository.appendAudit({
      actorType: "human",
      actorId: principal.id,
      serverId: principal.serverId,
      accountId,
      action: "gmail.grant.revoke",
      outcome: "succeeded",
      metadata: { agentId }
    });
    res.json({ ok: true, result: { deleted: true } });
  }));

  app.post("/actions/gmail-search", requireAgentSession(repository), asyncRoute(async (req, res) => {
    const body = z.object({
      accountId: z.uuid(),
      query: z.string().min(1).max(2048),
      maxResults: z.number().int().min(1).max(100).default(25)
    }).parse(req.body);
    const context = await authorizeAgent(repository, req, body.accountId, "gmail.read");
    if (!context.ok) return sendError(res, context.status, context.code, context.message);
    const result = await gmail.search(tokenVault.decrypt(context.account.encryptedRefreshToken), body.query, body.maxResults);
    await succeededAudit(repository, req, body.accountId, "gmail.search", { resultCount: result.length });
    res.json({ ok: true, result });
  }));

  app.post("/actions/gmail-read", requireAgentSession(repository), asyncRoute(async (req, res) => {
    const body = z.object({ accountId: z.uuid(), messageId: z.string().min(1).max(256) }).parse(req.body);
    const context = await authorizeAgent(repository, req, body.accountId, "gmail.read");
    if (!context.ok) return sendError(res, context.status, context.code, context.message);
    const result = await gmail.read(tokenVault.decrypt(context.account.encryptedRefreshToken), body.messageId);
    await succeededAudit(repository, req, body.accountId, "gmail.read", { messageId: body.messageId });
    res.json({ ok: true, result });
  }));

  app.post("/actions/gmail-draft-create", requireAgentSession(repository), asyncRoute(async (req, res) => {
    const body = draftInputSchema.parse(req.body);
    const context = await authorizeAgent(repository, req, body.accountId, "gmail.draft");
    if (!context.ok) return sendError(res, context.status, context.code, context.message);
    await performDraftOperation({
      repository,
      gmail,
      tokenVault,
      req,
      res,
      account: context.account,
      action: "gmail.draft.create",
      operationId: body.operationId,
      request: body,
      invoke: (refreshToken, input) => gmail.createDraft(refreshToken, input)
    });
  }));

  app.post("/actions/gmail-draft-update", requireAgentSession(repository), asyncRoute(async (req, res) => {
    const body = updateDraftSchema.parse(req.body);
    const context = await authorizeAgent(repository, req, body.accountId, "gmail.draft");
    if (!context.ok) return sendError(res, context.status, context.code, context.message);
    await performDraftOperation({
      repository,
      gmail,
      tokenVault,
      req,
      res,
      account: context.account,
      action: "gmail.draft.update",
      operationId: body.operationId,
      request: body,
      invoke: (refreshToken, input) => gmail.updateDraft(refreshToken, body.draftId, input)
    });
  }));

  app.get("/", (req, res) => {
    const principal = req.session?.principal as RaftPrincipal | undefined;
    res.type("html").send(`<!doctype html><html><head><meta charset="utf-8"><title>Raft Gmail</title></head><body><h1>Raft Gmail</h1><p>Self-hosted Gmail read and draft capabilities for explicitly authorized Raft Agents.</p><p>${principal ? `Signed in as ${escapeHtml(principal.name)}. <a href="/auth/google/start">Connect Gmail</a>` : '<a href="/auth/raft/login">Login with Raft</a>'}</p><p><a href="/.well-known/raft-app-manifest.json">App manifest</a></p></body></html>`);
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof z.ZodError) {
      return sendError(res, 400, "INVALID_REQUEST", "Request validation failed.", error.issues);
    }
    const code = error instanceof Error ? (error.message.split(":")[0] ?? "INTERNAL_ERROR") : "INTERNAL_ERROR";
    const safeCodes = new Set([
      "RAFT_TOKEN_EXCHANGE_FAILED",
      "RAFT_TOKEN_EXCHANGE_MISSING_ACCESS_TOKEN",
      "RAFT_USERINFO_FAILED",
      "RAFT_USERINFO_INVALID_PRINCIPAL",
      "GOOGLE_REFRESH_TOKEN_MISSING",
      "GOOGLE_EMAIL_MISSING"
    ]);
    return sendError(res, 500, safeCodes.has(code) ? code : "INTERNAL_ERROR", "The request could not be completed.");
  });

  return app;
}

function requireHuman(req: Request, res: Response, next: NextFunction) {
  const principal = req.session?.principal as RaftPrincipal | undefined;
  if (principal?.type === "human") return next();
  return sendError(res, 401, "HUMAN_SESSION_REQUIRED", "A Raft human session is required.");
}

function requireAgentSession(repository: Repository) {
  return asyncRoute(async (req, res, next) => {
    const token = bearerToken(req);
    if (!token) return sendError(res, 401, "AGENT_SESSION_REQUIRED", "A service-local Agent session is required.");
    const session = await repository.getAgentSession(hashOpaqueToken(token));
    if (!session) return sendError(res, 401, "AGENT_SESSION_INVALID", "The Agent session is invalid or expired.");
    req.agentSession = session;
    next();
  });
}

async function authorizeAgent(repository: Repository, req: Request, accountId: string, scope: GrantScope) {
  const session = req.agentSession!;
  const account = await repository.getGmailAccount(accountId);
  if (!account || account.serverId !== session.serverId) {
    await repository.appendAudit({
      actorType: "agent",
      actorId: session.agentId,
      serverId: session.serverId,
      action: scope,
      outcome: "denied"
    });
    return { ok: false as const, status: 404, code: "ACCOUNT_NOT_FOUND", message: "Gmail account not found." };
  }
  const grant = await repository.getGrant(accountId, session.agentId, session.serverId);
  if (!grant?.enabled || !grant.scopes.includes(scope)) {
    await repository.appendAudit({
      actorType: "agent",
      actorId: session.agentId,
      serverId: session.serverId,
      accountId,
      action: scope,
      outcome: "denied"
    });
    return { ok: false as const, status: 403, code: "CAPABILITY_DENIED", message: "This Agent lacks the required account capability." };
  }
  return { ok: true as const, account };
}

async function performDraftOperation(input: {
  repository: Repository;
  gmail: GmailGateway;
  tokenVault: TokenVault;
  req: Request;
  res: Response;
  account: GmailAccount;
  action: "gmail.draft.create" | "gmail.draft.update";
  operationId: string;
  request: {
    accountId: string;
    operationId: string;
    draftId?: string | undefined;
    to: string[];
    cc?: string[] | undefined;
    subject: string;
    bodyText: string;
    threadId?: string | undefined;
  };
  invoke: (refreshToken: string, input: DraftInput) => Promise<{ id: string; messageId?: string }>;
}) {
  const session = input.req.agentSession!;
  const requestHash = crypto.createHash("sha256").update(JSON.stringify(input.request)).digest("hex");
  const begun = await input.repository.beginDraftOperation({
    accountId: input.account.id,
    agentId: session.agentId,
    operationId: input.operationId,
    action: input.action,
    requestHash,
    status: "pending",
    updatedAt: new Date().toISOString()
  });
  if (!begun.created) {
    if (begun.operation.action !== input.action || begun.operation.requestHash !== requestHash) {
      return sendError(input.res, 409, "OPERATION_ID_REUSED", "The operation ID was already used for a different request.");
    }
    if (begun.operation.status === "succeeded" && begun.operation.providerDraftId) {
      return input.res.json({ ok: true, result: { id: begun.operation.providerDraftId, replayed: true } });
    }
    return sendError(
      input.res,
      409,
      "OPERATION_OUTCOME_UNKNOWN",
      "A prior attempt may have reached Gmail. Reconcile the live draft before using a new operation ID."
    );
  }

  const draftInput: DraftInput = {
    to: input.request.to,
    ...(input.request.cc ? { cc: input.request.cc } : {}),
    subject: input.request.subject,
    bodyText: input.request.bodyText,
    ...(input.request.threadId ? { threadId: input.request.threadId } : {})
  };
  try {
    const result = await input.invoke(input.tokenVault.decrypt(input.account.encryptedRefreshToken), draftInput);
    await input.repository.completeDraftOperation(input.account.id, session.agentId, input.operationId, result.id);
    await succeededAudit(input.repository, input.req, input.account.id, input.action, {
      operationId: input.operationId,
      providerDraftId: result.id
    });
    return input.res.json({ ok: true, result: { ...result, replayed: false } });
  } catch {
    await input.repository.appendAudit({
      actorType: "agent",
      actorId: session.agentId,
      serverId: session.serverId,
      accountId: input.account.id,
      action: input.action,
      outcome: "failed",
      operationId: input.operationId,
      metadata: { outcomeUnknown: true }
    });
    return sendError(
      input.res,
      502,
      "OPERATION_OUTCOME_UNKNOWN",
      "The Gmail write outcome is unknown. The service will not retry it automatically."
    );
  }
}

async function succeededAudit(
  repository: Repository,
  req: Request,
  accountId: string,
  action: string,
  metadata?: Record<string, unknown>
) {
  const session = req.agentSession!;
  await repository.appendAudit({
    actorType: "agent",
    actorId: session.agentId,
    serverId: session.serverId,
    accountId,
    action,
    outcome: "succeeded",
    ...(metadata?.operationId && typeof metadata.operationId === "string" ? { operationId: metadata.operationId } : {}),
    ...(metadata ? { metadata } : {})
  });
}

function publicAccount(account: GmailAccount) {
  return { id: account.id, email: account.email, serverId: account.serverId, createdAt: account.createdAt };
}

function humanPrincipal(req: Request): RaftPrincipal & { type: "human" } {
  return req.session!.principal as RaftPrincipal & { type: "human" };
}

function isOwnedAccount(account: GmailAccount | null, principal: RaftPrincipal) {
  return Boolean(account && account.ownerId === principal.id && account.serverId === principal.serverId);
}

function bearerToken(req: Request): string {
  const value = req.header("authorization") ?? "";
  return value.startsWith("Bearer ") ? value.slice("Bearer ".length) : "";
}

function requiredQuery(req: Request, name: string): string {
  const value = req.query[name];
  if (typeof value !== "string" || !value) throw new Error(`INVALID_${name.toUpperCase()}`);
  return value;
}

function noHeaderBreaks(value: string) {
  return !/[\r\n]/.test(value);
}

function sendError(res: Response, status: number, code: string, message: string, details?: unknown) {
  return res.status(status).json({ ok: false, error: { code, message, ...(details ? { details } : {}) } });
}

function asyncRoute(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
) {
  return (req: Request, res: Response, next: NextFunction) => {
    void handler(req, res, next).catch(next);
  };
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
