import { z } from "zod";

const configSchema = z.object({
  APP_ORIGIN: z.url().transform((value) => value.replace(/\/+$/, "")),
  PORT: z.coerce.number().int().positive().default(4184),
  DATABASE_URL: z.string().min(1).optional(),
  SESSION_SECRET: z.string().min(32),
  TOKEN_ENCRYPTION_KEY_BASE64: z.string().transform((value, ctx) => {
    const decoded = Buffer.from(value, "base64");
    if (decoded.length !== 32) {
      ctx.addIssue({ code: "custom", message: "must decode to exactly 32 bytes" });
      return z.NEVER;
    }
    return value;
  }),
  AGENT_SESSION_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  RAFT_APP_ORIGIN: z.url().transform((value) => value.replace(/\/+$/, "")),
  RAFT_API_ORIGIN: z.url().transform((value) => value.replace(/\/+$/, "")),
  RAFT_SETUP_PATH: z.string().startsWith("/"),
  RAFT_CLIENT_ID: z.string().min(1),
  RAFT_CLIENT_SECRET: z.string().min(1),
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1)
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): Config {
  return configSchema.parse({
    APP_ORIGIN: environment.APP_ORIGIN ?? "http://localhost:4184",
    PORT: environment.PORT ?? "4184",
    DATABASE_URL: environment.DATABASE_URL,
    SESSION_SECRET: environment.SESSION_SECRET,
    TOKEN_ENCRYPTION_KEY_BASE64: environment.TOKEN_ENCRYPTION_KEY_BASE64,
    AGENT_SESSION_TTL_SECONDS: environment.AGENT_SESSION_TTL_SECONDS ?? "900",
    RAFT_APP_ORIGIN: environment.RAFT_APP_ORIGIN ?? "https://app.raft.build",
    RAFT_API_ORIGIN: environment.RAFT_API_ORIGIN ?? "https://api.raft.build",
    RAFT_SETUP_PATH: environment.RAFT_SETUP_PATH ?? "/login-with-raft/setup",
    RAFT_CLIENT_ID: environment.RAFT_CLIENT_ID,
    RAFT_CLIENT_SECRET: environment.RAFT_CLIENT_SECRET,
    GOOGLE_CLIENT_ID: environment.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: environment.GOOGLE_CLIENT_SECRET
  });
}
