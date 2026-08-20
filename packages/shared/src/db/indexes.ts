import type { Db } from "mongodb";
import { COLLECTIONS } from "./collections";

/**
 * All index definitions live in code and are applied by an idempotent script
 * (npm run db:indexes), never created ad hoc. Re-running is always safe:
 * createIndex is a no-op when the spec already exists, the time-series
 * collection is guarded by an existence check, and each search index is
 * skipped when one of the same name is already present.
 */

const VECTOR_DIMENSIONS = 1024; // Voyage voyage-4 embedding size.

interface ApplyResult {
  created: string[];
  skipped: string[];
}

export async function applyIndexes(db: Db): Promise<ApplyResult> {
  const created: string[] = [];
  const skipped: string[] = [];

  // --- usage_events: a time-series collection ---------------------------
  // Time-series collections must be created explicitly (and before any insert)
  // via createCollection with a timeseries spec; they cannot be created lazily.
  const existing = await db
    .listCollections({ name: COLLECTIONS.usageEvents })
    .toArray();
  if (existing.length === 0) {
    await db.createCollection(COLLECTIONS.usageEvents, {
      timeseries: {
        timeField: "timestamp",
        metaField: "meta",
        granularity: "minutes",
      },
    });
    created.push(`collection:${COLLECTIONS.usageEvents} (time-series)`);
  } else {
    skipped.push(`collection:${COLLECTIONS.usageEvents}`);
  }

  // --- conversations: lookup + TTL --------------------------------------
  // The main list query is "this user's conversations, most recently updated
  // first", so a compound { userId, updatedAt:-1 } index serves it directly.
  await db
    .collection(COLLECTIONS.conversations)
    .createIndex({ userId: 1, updatedAt: -1 }, { name: "userId_updatedAt" });
  created.push("conversations.userId_updatedAt");

  // TTL on the guest-only expiresAt field. expireAfterSeconds:0 means "expire
  // exactly at the date stored in the field"; documents without the field are
  // never touched, so member/admin data is permanent.
  await db
    .collection(COLLECTIONS.conversations)
    .createIndex({ expiresAt: 1 }, { name: "expiresAt_ttl", expireAfterSeconds: 0 });
  created.push("conversations.expiresAt_ttl");

  // Scratch threads (operator lookups only) are swept by an hourly cron, and
  // this index is what makes "everything lapsed" a bounded lookup instead of a
  // collection scan. It is a PLAIN index on purpose: adding expireAfterSeconds
  // would hand the job to MongoDB's TTL reaper, which deletes only the
  // conversation document and would orphan the thread's checkpoints, jobs and
  // attached documents. The sweep exists so the delete runs the full cascade.
  await db
    .collection(COLLECTIONS.conversations)
    .createIndex({ scratchUntil: 1 }, { name: "scratchUntil_sweep" });
  created.push("conversations.scratchUntil_sweep");

  await db
    .collection(COLLECTIONS.memories)
    .createIndex({ expiresAt: 1 }, { name: "expiresAt_ttl", expireAfterSeconds: 0 });
  created.push("memories.expiresAt_ttl");

  // Phase 6: the always-on profile query runs on EVERY chat turn — the user's
  // active memories, highest importance first. This compound index serves it
  // directly (equality on userId + supersededBy, then the importance/recency
  // sort) so the resident block never costs a per-turn collection scan. It also
  // covers the /memories list's active-by-recency reads.
  await db
    .collection(COLLECTIONS.memories)
    .createIndex(
      { userId: 1, supersededBy: 1, importance: -1, lastAccessedAt: -1 },
      { name: "userId_active_importance" },
    );
  created.push("memories.userId_active_importance");

  // --- rate_limits: per-user sliding window (Phase 4) -------------------
  // One document per (userId, key); the unique compound index makes the
  // limiter's upsert race-safe. A TTL on updatedAt reaps rows a user has
  // stopped hitting so the collection never grows unbounded.
  await db
    .collection(COLLECTIONS.rateLimits)
    .createIndex({ userId: 1, key: 1 }, { name: "userId_key", unique: true });
  created.push("rate_limits.userId_key");

  await db
    .collection(COLLECTIONS.rateLimits)
    .createIndex(
      { updatedAt: 1 },
      { name: "updatedAt_ttl", expireAfterSeconds: 24 * 60 * 60 },
    );
  created.push("rate_limits.updatedAt_ttl");

  // --- jobs: the app<->worker bus (Phase 5) -----------------------------
  // The worker's claim/poll query is "the oldest queued job", so a compound
  // { status, createdAt } index serves both the change-stream catch-up and the
  // polling fallback directly (find status:queued, sort createdAt:1).
  await db
    .collection(COLLECTIONS.jobs)
    .createIndex({ status: 1, createdAt: 1 }, { name: "status_createdAt" });
  created.push("jobs.status_createdAt");

  // The UI lists a conversation's jobs (research cards); every such read filters
  // by userId (invariant #1) then conversationId, newest first.
  await db
    .collection(COLLECTIONS.jobs)
    .createIndex(
      { userId: 1, conversationId: 1, createdAt: -1 },
      { name: "userId_conversationId_createdAt" },
    );
  created.push("jobs.userId_conversationId_createdAt");

  // Guest memory-extraction jobs carry expiresAt; the same TTL pattern reaps
  // them so the coordination collection never accumulates ephemeral guest work.
  await db
    .collection(COLLECTIONS.jobs)
    .createIndex({ expiresAt: 1 }, { name: "expiresAt_ttl", expireAfterSeconds: 0 });
  created.push("jobs.expiresAt_ttl");

  // --- search_cache: the tiered answer-engine cache (Phase 8) -----------
  // The cache key IS the document _id (a hash of normalized query + intent +
  // source params), so a lookup is a primary-key hit and needs no extra index.
  // A TTL on expiresAt reaps each entry on its own intent-aware lifetime
  // (news-like minutes vs. evergreen weeks); expireAfterSeconds:0 means "expire
  // at the date stored in the field". The collection holds no user data, so no
  // userId index and no invariant-#1 concern (see SearchCacheEntrySchema).
  await db
    .collection(COLLECTIONS.searchCache)
    .createIndex({ expiresAt: 1 }, { name: "expiresAt_ttl", expireAfterSeconds: 0 });
  created.push("search_cache.expiresAt_ttl");

  // --- dictionary_cache: the Phase 10 dictionary-mode cache -------------
  // Same shape as search_cache: the cache key IS the _id (a hash of normalized
  // term + direction), so a lookup is a primary-key hit and needs no extra
  // index. A TTL on expiresAt reaps each entry on its evergreen lifetime. The
  // collection holds no user data, so no userId index and no invariant-#1
  // concern (see DictionaryCacheEntrySchema).
  await db
    .collection(COLLECTIONS.dictionaryCache)
    .createIndex({ expiresAt: 1 }, { name: "expiresAt_ttl", expireAfterSeconds: 0 });
  created.push("dictionary_cache.expiresAt_ttl");

  // --- quote_cache: the Phase 13 quote-mode cache -----------------------
  // Same shape again: the cache key IS the _id (a hash of the resolved symbol or
  // currency pair), so a lookup is a primary-key hit. The TTL here is the one
  // that varies per document by market state rather than by content type — an
  // open-market quote lives 60s, a closed-market one 30 minutes — which is
  // exactly what a per-document expiresAt TTL is for. No user data, so no userId
  // index and no invariant-#1 concern (see QuoteCacheEntrySchema).
  await db
    .collection(COLLECTIONS.quoteCache)
    .createIndex({ expiresAt: 1 }, { name: "expiresAt_ttl", expireAfterSeconds: 0 });
  created.push("quote_cache.expiresAt_ttl");

  // --- translation_cache: the Phase 14 translate-mode cache -------------
  // Same shape as dictionary_cache: the cache key IS the _id (a hash of the
  // normalized text + source + target), so a lookup is a primary-key hit and
  // needs no extra index, and a TTL on expiresAt reaps each entry on its
  // evergreen lifetime. No user data, so no userId index and no invariant-#1
  // concern (see TranslationCacheEntrySchema).
  await db
    .collection(COLLECTIONS.translationCache)
    .createIndex({ expiresAt: 1 }, { name: "expiresAt_ttl", expireAfterSeconds: 0 });
  created.push("translation_cache.expiresAt_ttl");

  // --- vector search indexes --------------------------------------------
  // Created programmatically against Atlas. Every search filters by userId as a
  // pre-filter (invariant: a vector search never returns another user's data),
  // so userId is a filter field on both indexes; chunks additionally filter by
  // documentId for per-document retrieval.
  await ensureVectorIndex(db, COLLECTIONS.memories, "memories_vector", [
    { type: "vector", path: "embedding", numDimensions: VECTOR_DIMENSIONS, similarity: "cosine" },
    { type: "filter", path: "userId" },
  ], created, skipped);

  await ensureVectorIndex(db, COLLECTIONS.chunks, "chunks_vector", [
    { type: "vector", path: "embedding", numDimensions: VECTOR_DIMENSIONS, similarity: "cosine" },
    { type: "filter", path: "userId" },
    { type: "filter", path: "documentId" },
  ], created, skipped);

  return { created, skipped };
}

async function ensureVectorIndex(
  db: Db,
  collectionName: string,
  indexName: string,
  fields: Array<Record<string, unknown>>,
  created: string[],
  skipped: string[],
): Promise<void> {
  // A vector search index can only be built on an existing collection, so
  // create it first if nothing else has (e.g. chunks has no regular index).
  const collections = await db
    .listCollections({ name: collectionName })
    .toArray();
  if (collections.length === 0) {
    await db.createCollection(collectionName);
  }

  const collection = db.collection(collectionName);
  const present = await collection.listSearchIndexes().toArray();
  if (present.some((idx) => idx.name === indexName)) {
    skipped.push(`${collectionName}.${indexName}`);
    return;
  }
  // Atlas builds the index asynchronously; createSearchIndex returns once the
  // build is queued. The name check above keeps re-runs idempotent.
  await collection.createSearchIndex({
    name: indexName,
    type: "vectorSearch",
    definition: { fields },
  });
  created.push(`${collectionName}.${indexName} (vector)`);
}
