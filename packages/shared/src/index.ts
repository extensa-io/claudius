// Public surface of @claudius/shared, consumed by the app (and, from Phase 4,
// the worker). Anything Next.js-bound stays in the app package; everything here
// is runtime-agnostic.

export {
  env,
  type Env,
  appEnv,
  assertAppEnv,
  type AppEnv,
} from "./env";
export { AppError, type AppErrorCode, isAppError } from "./errors";
export { clientPromise, getDb, DB_NAME } from "./db/client";
export * from "./db/collections";
export * from "./db/schemas";
export { applyIndexes } from "./db/indexes";
export { bedrockHealthProbe, type BedrockHealth } from "./bedrock/health";
export {
  embedTexts,
  embedQuery,
  EMBEDDING_DIMENSIONS,
} from "./embeddings/voyage";
export {
  MAX_DOCUMENT_BYTES,
  MAX_CHUNKS_PER_DOCUMENT,
  ALLOWED_UPLOAD_CONTENT_TYPES,
  UPLOAD_ACCEPT_ATTRIBUTE,
  classifyDocument,
  uploadContentTypeFor,
  IMAGE_MIME_BY_EXTENSION,
  type DocumentKind,
} from "./documents/constants";
export { parseAndEmbedDocument } from "./documents/parse";
export {
  resolveTurnImages,
  hydrateTurnImages,
  type TurnImage,
  type HydratedImage,
} from "./documents/images";
export * from "./answer";
export * from "./agent";
export * from "./tiers";
export * from "./usage";
export * from "./memory";
export * from "./user";
export * from "./ratelimit";
export * from "./admin";
export * from "./jobs";
