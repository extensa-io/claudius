import { ObjectId } from "mongodb";
import { memoriesCol } from "../db/collections";
import type { Memory, User } from "../db/schemas";

/**
 * Cross-category consolidation (Phase 6, scope item 4). Phase 3 dedup and
 * supersession were same-category only, so "located in Montreal" stored once as
 * a `fact` and again as `context` sat side by side, and near-duplicate phrasings
 * accumulated. A flat, growing store is exactly what pushes retrieval into the
 * compressed-score regime that defeats top-k. This periodic pass keeps the store
 * consolidated.
 *
 * It is deliberately a CHEAP HEURISTIC pass, not an agent reasoning over the
 * whole store on every turn (out of scope). It uses vector similarity plus a
 * salience-aware merge rule, and makes no model call — the LLM judgement in the
 * memory system lives in extraction and the one-time reclassify, not here. That
 * keeps consolidation deterministic, testable, and safe to run daily:
 *
 *   1. Cluster active memories whose vectors are near-identical (above a HIGH
 *      MERGE_SCORE), across categories. High bar so distinct facts never merge.
 *   2. In each cluster keep the most defining row as canonical (highest
 *      importance, newest to break ties), raise it to the cluster's max
 *      importance, and point the rest at it with supersededReason "merge". The
 *      merged rows stay as the audit trail — the /memories lineage shows them.
 *   3. Prune stale trivia: hard-delete active rows that are both very low
 *      salience and untouched for a long time, so minor one-offs don't bloat the
 *      store forever. Conservative thresholds; superseded rows are never touched.
 *
 * Owner-scoped throughout (invariant #1): every query filters by userId, and the
 * neighbor search pre-filters on userId inside $vectorSearch.
 */

/**
 * How similar two memories must be to merge. Higher than the same-category
 * SUPERSEDE_SCORE (0.88): a cross-category merge hides a row, so it must be a
 * near-restatement, not merely related. Measured: near-identical phrasings land
 * ~0.92–0.97, distinct same-category facts ~0.77. 0.92 catches the former and
 * clears the latter with margin. Tune with db/scripts/diagnose-memory.ts.
 */
const MERGE_SCORE = 0.92;

/** Prune only genuinely minor, long-untouched rows. Both must hold. */
const PRUNE_MAX_IMPORTANCE = 0.1;
const PRUNE_AGE_MS = 90 * 24 * 60 * 60 * 1000;

const NUM_CANDIDATES = 100;
const NEIGHBOR_LIMIT = 10;
const NEUTRAL_IMPORTANCE = 0.5;

export interface ConsolidationSummary {
  status: "ok" | "disabled" | "empty";
  /** Clusters of near-duplicates that were merged into one canonical row. */
  clustersMerged: number;
  /** Rows folded into a canonical (superseded with reason "merge"). */
  memoriesMerged: number;
  /** Stale low-salience rows hard-deleted. */
  pruned: number;
}

type ActiveMemory = Pick<
  Memory,
  "content" | "category" | "importance" | "embedding" | "createdAt"
> & { _id: ObjectId };

/**
 * Union-find over similarity edges: group ids that are transitively near-
 * duplicates into clusters. Pure so it's unit-testable without a database — the
 * merge logic's correctness is "which rows collapse together", and that lives
 * here. Returns only real clusters (size > 1).
 */
export function buildClusters(
  ids: string[],
  edges: Array<[string, string]>,
): string[][] {
  const parent = new Map<string, string>();
  for (const id of ids) parent.set(id, id);

  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    // Path compression so repeated finds stay near O(1).
    let cur = x;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };

  for (const [a, b] of edges) {
    if (!parent.has(a) || !parent.has(b)) continue;
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }

  const groups = new Map<string, string[]>();
  for (const id of ids) {
    const root = find(id);
    const group = groups.get(root) ?? [];
    group.push(id);
    groups.set(root, group);
  }
  return [...groups.values()].filter((g) => g.length > 1);
}

/**
 * The canonical row of a cluster: the most defining one (highest importance),
 * breaking ties by recency. Pure so the "which survives a merge" rule is
 * testable. Returns the id to keep.
 */
export function pickCanonical(
  members: Array<{ id: string; importance: number; createdAt: number }>,
): string {
  return [...members].sort((a, b) => {
    if (b.importance !== a.importance) return b.importance - a.importance;
    return b.createdAt - a.createdAt;
  })[0]!.id;
}

/** Nearest non-superseded neighbors above MERGE_SCORE, ACROSS categories, for
 * this user (owner pre-filter inside $vectorSearch, invariant #1). Excludes the
 * source row itself. */
async function mergeNeighbors(
  userId: ObjectId,
  self: ActiveMemory,
): Promise<string[]> {
  const col = await memoriesCol();
  const hits = (await col
    .aggregate([
      {
        $vectorSearch: {
          index: "memories_vector",
          path: "embedding",
          queryVector: self.embedding,
          numCandidates: NUM_CANDIDATES,
          limit: NEIGHBOR_LIMIT,
          filter: { userId: { $eq: userId } },
        },
      },
      { $addFields: { score: { $meta: "vectorSearchScore" } } },
      { $match: { supersededBy: null } },
      { $project: { _id: 1, score: 1 } },
    ])
    .toArray()) as Array<{ _id: ObjectId; score: number }>;

  const selfId = self._id.toString();
  return hits
    .filter((h) => h.score >= MERGE_SCORE && h._id.toString() !== selfId)
    .map((h) => h._id.toString());
}

export async function consolidateUserMemories(params: {
  user: User;
}): Promise<ConsolidationSummary> {
  const { user } = params;
  const userId = user._id!;

  // Master switch: a user with memory off gets no consolidation, mirroring
  // extraction and retrieval (the whole feature is off for them).
  if (user.memoryEnabled === false) {
    return { status: "disabled", clustersMerged: 0, memoriesMerged: 0, pruned: 0 };
  }

  const col = await memoriesCol();
  const active = (await col
    .find({ userId, supersededBy: null })
    .project({ content: 1, category: 1, importance: 1, embedding: 1, createdAt: 1 })
    .toArray()) as ActiveMemory[];

  if (active.length === 0) {
    return { status: "empty", clustersMerged: 0, memoriesMerged: 0, pruned: 0 };
  }

  const byId = new Map(active.map((m) => [m._id.toString(), m]));

  // Build similarity edges: one neighbor search per active row. n is small for a
  // single user's store and this runs off the request path (worker), daily.
  const edges: Array<[string, string]> = [];
  for (const mem of active) {
    const neighbors = await mergeNeighbors(userId, mem);
    for (const nId of neighbors) {
      if (byId.has(nId)) edges.push([mem._id.toString(), nId]);
    }
  }

  const clusters = buildClusters([...byId.keys()], edges);

  let memoriesMerged = 0;
  for (const cluster of clusters) {
    const members = cluster.map((id) => {
      const m = byId.get(id)!;
      return {
        id,
        importance: m.importance ?? NEUTRAL_IMPORTANCE,
        createdAt: m.createdAt.getTime(),
      };
    });
    const canonicalId = pickCanonical(members);
    const maxImportance = Math.max(...members.map((m) => m.importance));

    // Keep canonical active at the cluster's top salience; fold the rest into it.
    await col.updateOne(
      { _id: new ObjectId(canonicalId), userId },
      { $set: { importance: maxImportance } },
    );
    const mergedIds = cluster
      .filter((id) => id !== canonicalId)
      .map((id) => new ObjectId(id));
    if (mergedIds.length > 0) {
      const res = await col.updateMany(
        { _id: { $in: mergedIds }, userId, supersededBy: null },
        {
          $set: {
            supersededBy: new ObjectId(canonicalId),
            supersededReason: "merge",
          },
        },
      );
      memoriesMerged += res.modifiedCount;
    }
  }

  // Prune stale trivia. Only rows that are BOTH very low salience AND untouched
  // for a long time, and never anything already superseded (that's the audit
  // trail). Conservative by design — a background job must not surprise the user
  // by dropping anything they'd expect to still be there.
  const pruneBefore = new Date(Date.now() - PRUNE_AGE_MS);
  const pruneRes = await col.deleteMany({
    userId,
    supersededBy: null,
    importance: { $lte: PRUNE_MAX_IMPORTANCE },
    lastAccessedAt: { $lt: pruneBefore },
  });

  return {
    status: "ok",
    clustersMerged: clusters.length,
    memoriesMerged,
    pruned: pruneRes.deletedCount ?? 0,
  };
}
