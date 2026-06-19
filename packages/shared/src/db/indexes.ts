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

  await db
    .collection(COLLECTIONS.memories)
    .createIndex({ expiresAt: 1 }, { name: "expiresAt_ttl", expireAfterSeconds: 0 });
  created.push("memories.expiresAt_ttl");

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
