import { ObjectId } from "mongodb";
import { memoriesCol } from "../db/collections";
import { embedQuery } from "../embeddings/voyage";
import type { RetrievedMemory } from "./types";

/**
 * Retrieval for the graph's `load_context` node (Phase 6). Two paths feed a turn:
 *
 *   1. `retrieveMemories` — the salience-weighted vector match for THIS query.
 *   2. `getProfileMemories` — the always-on resident identity block, injected
 *      every turn regardless of vector score (a small core-memory tier).
 *
 * Owner isolation is a PRE-filter inside $vectorSearch (invariant #1). Retrieved
 * memories have their `lastAccessedAt` bumped (the signal the cap evictor uses);
 * the profile does NOT bump it, so an always-on row never looks "freshly used"
 * and never freezes LRU eviction.
 *
 * WHY THIS REPLACES THE PHASE 3 CALIBRATION. The post-Phase-3 stopgap gated on a
 * flat absolute floor and injected the top-few on a miss. That fixed amnesia but
 * not ranking: over a flat, unsalienced store, scores compress into a narrow band
 * (a question against a user's stored facts clusters ~0.55–0.67), so a defining
 * fact could rank below a trivial one that happened to phrase-match. Phase 6
 * fixes ranking at the source:
 *
 *   - Salience blend: each hit's score is nudged by its `importance` (0..1,
 *     0.5 neutral), so a defining fact is lifted above trivia in the same band.
 *   - Adaptive thresholding: instead of one global floor, keep hits within a
 *     band of THIS query's top blended score (relative to the user's own
 *     distribution), above a low absolute noise floor.
 *   - Never-blind fallback retained: if too few clear the band, return the top
 *     few by blended score so a thin turn is never fully blind. The resident
 *     profile is the other half of that guarantee.
 */

const TOP_K = 5;
const NUM_CANDIDATES = 100;
// Over-fetch before the supersededBy filter so a superseded neighbor in the
// top-k doesn't shrink the result below TOP_K.
const SEARCH_LIMIT = 15;

/**
 * How hard `importance` bends the ranking. A hit's blended score is
 * `cosineScore + IMPORTANCE_WEIGHT * (importance - 0.5)`: a defining fact
 * (importance ~0.9) gains ~+0.06, a trivial one (~0.1) loses ~-0.06. In the
 * measured 0.55–0.67 band that ±0.06 swing is enough to reorder a defining fact
 * above a phrase-matching trivial one, which is the whole point. Tune here and
 * re-measure with `db/scripts/diagnose-memory.ts`.
 */
const IMPORTANCE_WEIGHT = 0.15;

/** Missing importance (a row written before Phase 6) reads as neutral. */
const NEUTRAL_IMPORTANCE = 0.5;

/**
 * Adaptive threshold. Atlas normalizes cosine to (1 + cosine) / 2: 0.5 is
 * unrelated, 1.0 identical. We keep blended hits that are BOTH within
 * `RELATIVE_BAND` of this query's best blended score (so the bar rises when the
 * query matches something strongly and relaxes when nothing does) AND above the
 * absolute noise floor (so a query that matches nothing doesn't drag junk in).
 */
const ABS_FLOOR = 0.5;
const RELATIVE_BAND = 0.08;

/**
 * The never-blind floor. When fewer than this clear the adaptive band, return
 * the highest-blended few anyway, so the model always has SOME grounding rather
 * than amnesia. The resident profile is the other guarantee. Set to 0 to restore
 * strict "inject nothing below the band" behaviour.
 */
const MIN_INJECT = 3;

/** How many resident identity memories the always-on profile carries. */
const PROFILE_SIZE = 5;
/**
 * Only genuinely defining rows belong in the always-on block; ordinary and minor
 * memories stay in the vector path where they only surface when relevant. This
 * keeps the resident block small and identity-focused rather than a raw dump.
 */
const PROFILE_MIN_IMPORTANCE = 0.7;

interface MemoryHit {
  _id: ObjectId;
  content: string;
  category: RetrievedMemory["category"];
  score: number;
  importance?: number;
}

function blend(hit: MemoryHit): number {
  const importance = hit.importance ?? NEUTRAL_IMPORTANCE;
  return hit.score + IMPORTANCE_WEIGHT * (importance - 0.5);
}

/**
 * The always-on profile: the user's highest-salience identity memories, chosen
 * without a vector search so identity is available on a turn that resembles no
 * stored fact ("who am I?", a contentless follow-up). Kept small and defining
 * only. Does NOT bump `lastAccessedAt` — an always-injected row must not look
 * perpetually fresh to the LRU evictor.
 */
export async function getProfileMemories(
  userId: ObjectId,
): Promise<RetrievedMemory[]> {
  const col = await memoriesCol();
  const rows = await col
    .find({
      userId,
      supersededBy: null,
      importance: { $gte: PROFILE_MIN_IMPORTANCE },
    })
    // Most defining first, then most recently touched to break ties.
    .sort({ importance: -1, lastAccessedAt: -1 })
    .limit(PROFILE_SIZE)
    .project({ _id: 1, content: 1, category: 1 })
    .toArray();

  return rows.map((r) => ({
    id: r._id!.toString(),
    content: r.content as string,
    category: r.category as RetrievedMemory["category"],
    source: "profile" as const,
  }));
}

export async function retrieveMemories(
  userId: ObjectId,
  queryText: string,
  excludeIds: string[] = [],
): Promise<RetrievedMemory[]> {
  const trimmed = queryText.trim();
  if (trimmed.length === 0) return [];

  const queryVector = await embedQuery(trimmed);
  const col = await memoriesCol();

  // Fetch scored candidates (owner-prefiltered, non-superseded). Thresholding is
  // applied in code, not the pipeline, so the never-blind fallback can reach past
  // the band when nothing clears it and so importance can re-rank the raw scores.
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
      { $project: { _id: 1, content: 1, category: 1, score: 1, importance: 1 } },
    ])
    .toArray()) as MemoryHit[];

  // Drop anything already in the resident profile so the two paths don't
  // double-inject the same fact (and the "used N memories" count stays honest).
  const excluded = new Set(excludeIds);
  const ranked = scored
    .filter((h) => !excluded.has(h._id.toString()))
    .map((h) => ({ hit: h, blended: blend(h) }))
    .sort((a, b) => b.blended - a.blended);

  if (ranked.length === 0) return [];

  const top = ranked[0]!.blended;
  const withinBand = ranked
    .filter((r) => r.blended >= ABS_FLOOR && r.blended >= top - RELATIVE_BAND)
    .slice(0, TOP_K);
  // Enough cleared the adaptive band: use them. Otherwise fall back to the top
  // few by blended score so a thin or awkward query never yields zero memories.
  const chosen =
    withinBand.length >= MIN_INJECT ? withinBand : ranked.slice(0, MIN_INJECT);

  const hits = chosen.map((r) => r.hit);
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
    source: "retrieved" as const,
  }));
}
