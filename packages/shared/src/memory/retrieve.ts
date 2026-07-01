import { ObjectId } from "mongodb";
import { memoriesCol } from "../db/collections";
import { embedQuery } from "../embeddings/voyage";
import type { RetrievedMemory } from "./types";

/**
 * Retrieval for the graph's `load_context` node: the user's most relevant
 * non-superseded memories for the incoming message.
 *
 * Owner isolation is a PRE-filter inside $vectorSearch (invariant #1). Retrieved
 * memories have their `lastAccessedAt` bumped, which is also the signal the cap
 * evictor uses to decide what's stale.
 *
 * CALIBRATION (post-Phase-3): the original design gated retrieval behind an
 * absolute 0.62 floor and injected nothing below it. Live measurement showed
 * that floor was calibrated on the wrong distribution — it was tuned against
 * declarative-vs-declarative supersession scores (0.77–0.97), but real retrieval
 * scores a user's QUESTION against stored declarative facts, and those cluster
 * in 0.58–0.67. A 0.62 floor bisected the actual signal, so identity questions
 * ("who am I?") dropped every memory and the model answered with confident
 * amnesia. Two changes here, both deliberately favouring recall over precision:
 *
 *   1. MIN_SCORE lowered to 0.55, below the measured relevant cluster.
 *   2. MIN_INJECT: if fewer than this clears the floor, we still return the top
 *      few by score. A retrieval miss must never mean the model is fully blind
 *      to who it is talking to — better a weakly-related fact than amnesia.
 *
 * This is a calibration, not a cure. Because scores across a user's memories are
 * compressed into a narrow band, top-k ordering is noisy and a defining fact can
 * still rank below a trivial one on an awkwardly phrased query. The structural
 * fix — salience-weighted retrieval and an always-on profile — is Phase 6.
 */

const TOP_K = 5;
const NUM_CANDIDATES = 100;
// Over-fetch before the supersededBy filter so a superseded neighbor in the
// top-k doesn't shrink the result below TOP_K.
const SEARCH_LIMIT = 15;

/**
 * Atlas normalizes cosine to (1 + cosine) / 2: 0.5 is unrelated, 1.0 identical.
 * 0.55 sits just below the measured 0.58–0.67 band of a question against this
 * user's stored facts: it keeps related memories and drops only true noise. Tune
 * here, and re-measure with `db/scripts/diagnose-memory.ts` after any change.
 */
const MIN_SCORE = 0.55;

/**
 * The never-blind floor. When fewer than this many memories clear MIN_SCORE, we
 * still return the highest-scoring few rather than nothing, so the model always
 * has *some* grounding in who the user is. Set to 0 to restore the strict
 * "inject nothing below the floor" behaviour.
 */
const MIN_INJECT = 3;

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

  // Fetch scored candidates (owner-prefiltered, non-superseded) and apply the
  // floor in code rather than in the pipeline, so the never-blind fallback can
  // reach below MIN_SCORE when nothing clears it. Sorted by score descending.
  const scored = (await col
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
      { $match: { supersededBy: null } },
      { $sort: { score: -1 } },
      { $project: { _id: 1, content: 1, category: 1, score: 1 } },
    ])
    .toArray()) as MemoryHit[];

  const aboveFloor = scored
    .filter((h) => h.score >= MIN_SCORE)
    .slice(0, TOP_K);
  // Enough cleared the floor: use them. Otherwise fall back to the top few by
  // score so a thin or awkwardly-phrased query never yields zero memories.
  const hits =
    aboveFloor.length >= MIN_INJECT ? aboveFloor : scored.slice(0, MIN_INJECT);

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
