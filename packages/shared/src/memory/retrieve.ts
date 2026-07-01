import { ObjectId } from "mongodb";
import { memoriesCol } from "../db/collections";
import { embedQuery } from "../embeddings/voyage";
import type { RetrievedMemory } from "./types";

/**
 * Retrieval for the graph's `load_context` node: the user's most relevant
 * non-superseded memories for the incoming message.
 *
 * Owner isolation is a PRE-filter inside $vectorSearch (invariant #1). The
 * similarity floor matters as much as top-k: below it we return nothing rather
 * than pad the prompt with weakly related memories, so a question about cooking
 * doesn't drag in a memory about the user's editor. Retrieved memories have
 * their `lastAccessedAt` bumped, which is also the signal the cap evictor uses
 * to decide what's stale.
 */

const TOP_K = 5;
const NUM_CANDIDATES = 100;
// Over-fetch before the supersededBy filter so a superseded neighbor in the
// top-k doesn't shrink the result below TOP_K.
const SEARCH_LIMIT = 15;

/**
 * Atlas normalizes cosine to (1 + cosine) / 2: 0.5 is unrelated, 1.0 identical.
 * 0.62 keeps clearly-related memories and drops the merely-adjacent. Tune here.
 */
const MIN_SCORE = 0.62;

interface MemoryHit {
  _id: ObjectId;
  content: string;
  category: RetrievedMemory["category"];
  score: number;
}

export async function retrieveMemories(
  userId: ObjectId,
  queryText: string,
): Promise<RetrievedMemory[]> {
  const trimmed = queryText.trim();
  if (trimmed.length === 0) return [];

  const queryVector = await embedQuery(trimmed);
  const col = await memoriesCol();

  const hits = (await col
    .aggregate([
      {
        $vectorSearch: {
          index: "memories_vector",
          path: "embedding",
          queryVector,
          numCandidates: NUM_CANDIDATES,
          limit: SEARCH_LIMIT,
          filter: { userId: { $eq: userId } },
        },
      },
      { $addFields: { score: { $meta: "vectorSearchScore" } } },
      { $match: { supersededBy: null, score: { $gte: MIN_SCORE } } },
      { $limit: TOP_K },
      { $project: { _id: 1, content: 1, category: 1, score: 1 } },
    ])
    .toArray()) as MemoryHit[];

  if (hits.length === 0) return [];

  const ids = hits.map((h) => h._id);
  const now = new Date();
  // Mark them used: powers the LRU eviction order and the "last used" timestamp
  // in the /memories view. Scoped by userId as defense in depth.
  await col.updateMany(
    { _id: { $in: ids }, userId },
    { $set: { lastAccessedAt: now } },
  );

  return hits.map((h) => ({
    id: h._id.toString(),
    content: h.content,
    category: h.category,
  }));
}
