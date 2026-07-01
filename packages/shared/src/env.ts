import { z } from "zod";

/**
 * The single source of truth for secrets and runtime configuration.
 *
 * Every variable is validated once, at module load, so a misconfigured
 * deployment fails fast on boot with a clear message instead of throwing a
 * cryptic error deep inside a request. Only the variable *names* are ever
 * surfaced on failure; values are never logged (invariant: never log secrets).
 *
 * Each phase declares only the variables it actually uses. Later phases add
 * their own (Voyage, Blob, LangSmith) as they arrive.
 */
const EnvSchema = z.object({
  MONGODB_URI: z.string().url(),
  AUTH_SECRET: z.string().min(1),
  AUTH_GOOGLE_ID: z.string().min(1),
  AUTH_GOOGLE_SECRET: z.string().min(1),
  AWS_ACCESS_KEY_ID: z.string().min(1),
  AWS_SECRET_ACCESS_KEY: z.string().min(1),
  AWS_REGION: z.string().min(1),
  ADMIN_EMAIL: z.string().email(),
  // Phase 1: Tavily powers the agent's web_search tool.
  TAVILY_API_KEY: z.string().min(1),
  // Phase 2: Voyage embeds document chunks; Vercel Blob stores the raw files.
  VOYAGE_API_KEY: z.string().min(1),
  BLOB_READ_WRITE_TOKEN: z.string().min(1),
  // Phase 3: shared secret Vercel Cron sends as `Authorization: Bearer` so the
  // memory-extraction cron route can reject any request it did not schedule.
  CRON_SECRET: z.string().min(1),
});

export type Env = z.infer<typeof EnvSchema>;

function loadEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    // List the offending variable names only, never their values.
    const offenders = parsed.error.issues
      .map((issue) => issue.path.join("."))
      .join(", ");
    throw new Error(
      `Invalid environment configuration. Check these variables: ${offenders}`,
    );
  }
  return parsed.data;
}

export const env: Env = loadEnv();
