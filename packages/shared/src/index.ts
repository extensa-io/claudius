// Public surface of @claudius/shared, consumed by the app (and, from Phase 4,
// the worker). Anything Next.js-bound stays in the app package; everything here
// is runtime-agnostic.

export { env, type Env } from "./env";
export { AppError, type AppErrorCode, isAppError } from "./errors";
export { clientPromise, getDb, DB_NAME } from "./db/client";
export * from "./db/collections";
export * from "./db/schemas";
export { applyIndexes } from "./db/indexes";
export { bedrockHealthProbe, type BedrockHealth } from "./bedrock/health";
export * from "./agent";
export * from "./tiers";
export * from "./usage";
