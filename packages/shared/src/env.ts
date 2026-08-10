import { z } from "zod";

/**
 * The single source of truth for secrets and runtime configuration.
 *
 * Every variable is validated once, at module load, so a misconfigured
 * deployment fails fast on boot with a clear message instead of throwing a
 * cryptic error deep inside a request. Only the variable *names* are ever
 * surfaced on failure; values are never logged (invariant: never log secrets).
 *
 * From Phase 5 this schema serves TWO runtimes: the Next.js app on Vercel and
 * the Railway worker. The worker imports `@claudius/shared` (and thus this
 * module) but has no business with Google OAuth, the Auth.js secret, the Blob
 * token, the cron secret, or the bootstrap admin email. Rather than force the
 * worker to carry app-only secrets, those vars are *optional* in the base
 * schema — always parsed, never required here — and re-validated as a required
 * group by `assertAppEnv()` at the app's own boundary (see auth/config). The
 * split is: this base is what both runtimes need; `appEnv()` is what only the
 * app needs. Neither runtime validates the other's surface.
 */
const EnvSchema = z.object({
  // --- Required in both the app and the worker --------------------------
  MONGODB_URI: z.string().url(),
  AWS_ACCESS_KEY_ID: z.string().min(1),
  AWS_SECRET_ACCESS_KEY: z.string().min(1),
  AWS_REGION: z.string().min(1),
  // Phase 1: Tavily powers the agent's web_search tool (and the worker's
  // research fetch/search). Phase 2: Voyage embeds chunks and memories, which
  // the worker's memory extraction also needs. Both runtimes require them.
  TAVILY_API_KEY: z.string().min(1),
  VOYAGE_API_KEY: z.string().min(1),
  // Phase 7: Brave Search is the primary web-search backend for the answer
  // engine (Tavily is demoted to fallback + high-value slot). The engine lives
  // in shared and is runtime-agnostic, so the key is required in the base schema
  // like TAVILY_API_KEY — both runtimes validate it even though only the app's
  // web_search tool exercises the engine this phase.
  BRAVE_API_KEY: z.string().min(1),

  // --- App-only (optional here; asserted by assertAppEnv at the app boundary) --
  AUTH_SECRET: z.string().min(1).optional(),
  AUTH_GOOGLE_ID: z.string().min(1).optional(),
  AUTH_GOOGLE_SECRET: z.string().min(1).optional(),
  ADMIN_EMAIL: z.string().email().optional(),
  BLOB_READ_WRITE_TOKEN: z.string().min(1).optional(),
  // Phase 3: shared secret Vercel Cron sends as `Authorization: Bearer` so the
  // cron routes can reject any request they did not schedule.
  CRON_SECRET: z.string().min(1).optional(),

  // --- Worker-only (Phase 5) --------------------------------------------
  // How the worker consumes the `jobs` collection: a MongoDB change stream on
  // inserts (default, needs a replica set — Atlas M10+) or a polling fallback
  // (the documented path for readers on Atlas M0, which has no change streams).
  JOB_CONSUME_MODE: z.enum(["changestream", "poll"]).optional(),

  // --- Optional in both: GitHub read_url auth (Phase 11) ----------------
  // read_url's GitHub path calls the public REST API unauthenticated by default.
  // A token is NOT required — it only raises the rate limit — so it's optional in
  // the base schema and simply absent when unset. Only the app's read_url tool
  // reads it, but it lives in the shared base so a deployment that DOES set it is
  // validated at boot in both runtimes.
  GITHUB_TOKEN: z.string().min(1).optional(),

  // --- Optional in both: market data (Phase 13) -------------------------
  // Twelve Data backs quote mode (`$MDB`, `$500 CAD to COP`). OPTIONAL, not
  // required: only the app's quote path calls it, the worker never quotes, and a
  // deployment without the key should still boot — the quote path then returns a
  // clean "quotes are unavailable" message instead of failing at startup. Listed
  // here so a deployment that DOES set it is validated at boot.
  TWELVEDATA_API_KEY: z.string().min(1).optional(),

  // --- Optional in both: LangSmith tracing ------------------------------
  // LangChain JS auto-instruments from these process.env vars when
  // LANGSMITH_TRACING is "true" and an API key is present; absent, tracing is
  // simply off and no code path changes. Listed so a deployment that DOES set
  // them is validated at boot, in the app and the worker alike (Phase 5 extends
  // tracing into the worker behind these same flags).
  LANGSMITH_TRACING: z.enum(["true", "false"]).optional(),
  LANGSMITH_API_KEY: z.string().min(1).optional(),
  LANGSMITH_PROJECT: z.string().min(1).optional(),
  LANGSMITH_ENDPOINT: z.string().url().optional(),
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

/**
 * The app-only secrets, validated as a required group. The Next.js app calls
 * `appEnv()` at its boundary (Auth.js config, the cron routes, Blob reads) so
 * these are proven present in the app process, while the worker — which never
 * calls it — is spared from carrying secrets it does not use. Re-parsing here
 * (rather than reading the optional fields off `env` with non-null assertions)
 * keeps the returned type honestly required and fails with the offending names.
 */
const AppEnvSchema = z.object({
  AUTH_SECRET: z.string().min(1),
  AUTH_GOOGLE_ID: z.string().min(1),
  AUTH_GOOGLE_SECRET: z.string().min(1),
  ADMIN_EMAIL: z.string().email(),
  BLOB_READ_WRITE_TOKEN: z.string().min(1),
  CRON_SECRET: z.string().min(1),
});

export type AppEnv = z.infer<typeof AppEnvSchema>;

let cachedAppEnv: AppEnv | null = null;

export function assertAppEnv(): AppEnv {
  const parsed = AppEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const offenders = parsed.error.issues
      .map((issue) => issue.path.join("."))
      .join(", ");
    throw new Error(
      `Invalid app environment configuration. Check these variables: ${offenders}`,
    );
  }
  return parsed.data;
}

/** Cached accessor for the app-only secrets; validates once per process. */
export function appEnv(): AppEnv {
  return (cachedAppEnv ??= assertAppEnv());
}
