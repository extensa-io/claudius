import { ObjectId } from "mongodb";
import { memoriesCol } from "../db/collections";
import type { Memory, Role } from "../db/schemas";
import { embedTexts } from "../embeddings/voyage";
import type { MemoryCandidate, PersistOutcome } from "./types";

/**
 * Dedup, supersession, caps, and insertion for a single extracted candidate.
 *
 * The interesting design decision (and a good article beat): "is this the same
 * memory, an update to it, or something new?" is answered with vector similarity
 * plus a cheap text check, not another model call. We look up the nearest
 * existing memory in the SAME category and branch:
 *
 *   - near-identical text, high similarity  -> skip (a restatement, already known)
 *   - high similarity, different text        -> supersede (an update to that fact)
 *   - otherwise                              -> insert as a brand-new memory
 *
 * `supersededBy` is set on the OLD memory pointing at the new one, which both
 * excludes it from retrieval and powers the "↳ replaced an earlier memory"
 * affordance in the UI. Superseded rows are never deleted — they are the audit
 * trail. This is a heuristic tuned for transparency over cleverness; a stronger
 * variant would ask an LLM to judge consistent-vs-conflicting, at extra cost.
 */

/**
 * Atlas normalizes cosine similarity to (1 + cosine) / 2, so 1.0 is identical,
 * 0.5 is unrelated. 0.88 means "clearly about the same thing" — the band where a
 * new statement is almost always an update to an existing memory.
 *
 * Tuned against measured voyage-4 scores: same-topic updates land ~0.91–0.97
 * ("Lives in Toronto" vs "Now based in Montreal" = 0.91; vs "Lives in Montreal"
 * = 0.97), while unrelated same-category facts sit ~0.77 ("Lives in Toronto" vs
 * "Owns a dog"). 0.88 clears the unrelated cluster with wide margin and catches
 * rephrased updates.
 */
const SUPERSEDE_SCORE = 0.88;

/** Guest memories are ephemeral, mirroring the 24h TTL on guest conversations. */
const GUEST_MEMORY_TTL_MS = 24 * 60 * 60 * 1000;

const NUM_CANDIDATES = 100;
const NEIGHBOR_LIMIT = 10;

interface NeighborHit {
  _id: ObjectId;
  content: string;
  category: string;
  score: number;
}

/** Lowercased, whitespace- and punctuation-trimmed, for the "same text" check. */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

export type PersistDecision = "skip" | "supersede" | "insert";

/**
 * The pure dedup/supersession decision, split out so it's unit-testable without
 * a database or embeddings. Given the candidate and its nearest SAME-CATEGORY
 * neighbor (if any), decide whether this is a restatement (skip), an update to
 * that memory (supersede), or something new (insert).
 */
export function decidePersistence(
  candidateContent: string,
  neighbor: { content: string; score: number } | undefined,
): PersistDecision {
  if (!neighbor || neighbor.score < SUPERSEDE_SCORE) return "insert";
  return normalize(neighbor.content) === normalize(candidateContent)
    ? "skip"
    : "supersede";
}

/**
 * Nearest non-superseded memories for this user, owner-prefiltered inside
 * $vectorSearch (invariant #1: a vector search never considers another user's
 * vectors). `supersededBy` is filtered in a following $match — it's a relevance
 * concern, not a security boundary, and it isn't a filter field on the index.
 */
async function nearestNeighbors(
  userId: ObjectId,
  embedding: number[],
): Promise<NeighborHit[]> {
  const col = await memoriesCol();
  return (await col
    .aggregate([
      {
        $vectorSearch: {
          index: "memories_vector",
          path: "embedding",
          queryVector: embedding,
          numCandidates: NUM_CANDIDATES,
          limit: NEIGHBOR_LIMIT,
          filter: { userId: { $eq: userId } },
        },
      },
      { $addFields: { score: { $meta: "vectorSearchScore" } } },
      { $match: { supersededBy: null } },
      { $project: { _id: 1, content: 1, category: 1, score: 1 } },
    ])
    .toArray()) as NeighborHit[];
}

function buildMemoryDoc(params: {
  userId: ObjectId;
  role: Role;
  candidate: MemoryCandidate;
  embedding: number[];
  sourceConversationId: ObjectId;
}): Memory {
  const now = new Date();
  const base: Memory = {
    userId: params.userId,
    content: params.candidate.content,
    category: params.candidate.category,
    embedding: params.embedding,
    sourceConversationId: params.sourceConversationId,
    createdAt: now,
    lastAccessedAt: now,
    supersededBy: null,
  };
  // Guests get an expiresAt for the TTL index (invariant #4); members/admins omit
  // the field entirely so their memories are permanent.
  return params.role === "guest"
    ? { ...base, expiresAt: new Date(now.getTime() + GUEST_MEMORY_TTL_MS) }
    : base;
}

/**
 * Enforce the per-tier cap before inserting a NEW memory. At or above the cap we
 * evict the least recently used non-superseded memory (oldest `lastAccessedAt`)
 * until there is room. Superseded rows don't count toward the cap and are never
 * evicted here — they're the audit trail. Supersession itself is net-zero on the
 * active count, so it doesn't pass through this path.
 */
async function enforceCap(userId: ObjectId, cap: number): Promise<void> {
  const col = await memoriesCol();
  // Loop defensively, but in steady state this removes at most one row.
  for (let guard = 0; guard < 100; guard += 1) {
    const active = await col.countDocuments({ userId, supersededBy: null });
    if (active < cap) return;
    const oldest = await col
      .find({ userId, supersededBy: null })
      .sort({ lastAccessedAt: 1 })
      .limit(1)
      .next();
    if (!oldest?._id) return;
    await col.deleteOne({ _id: oldest._id, userId });
  }
}

export async function persistCandidate(params: {
  userId: ObjectId;
  role: Role;
  memoryCap: number;
  candidate: MemoryCandidate;
  sourceConversationId: ObjectId;
}): Promise<PersistOutcome> {
  const { userId, role, memoryCap, candidate, sourceConversationId } = params;
  const col = await memoriesCol();

  const [embedding] = await embedTexts([candidate.content]);
  if (!embedding) throw new Error("Failed to embed memory candidate.");

  const neighbors = await nearestNeighbors(userId, embedding);
  // Only same-category memories can supersede one another, so a new preference
  // never clobbers a fact that happens to sit nearby in vector space.
  const best = neighbors.find((n) => n.category === candidate.category);
  const decision = decidePersistence(candidate.content, best);

  if (decision === "skip") {
    return { action: "skipped", reason: "duplicate" };
  }

  if (decision === "supersede" && best) {
    // An update to a known fact: insert the new memory, then point the old one
    // at it. Active count is unchanged, so no cap enforcement is needed.
    const doc = buildMemoryDoc({
      userId,
      role,
      candidate,
      embedding,
      sourceConversationId,
    });
    const inserted = await col.insertOne(doc);
    const newId = inserted.insertedId;
    if (!newId) throw new Error("Memory insert returned no id.");
    await col.updateOne(
      { _id: best._id, userId },
      { $set: { supersededBy: newId } },
    );
    return {
      action: "superseded",
      memoryId: newId.toString(),
      supersededId: best._id.toString(),
      content: candidate.content,
      previousContent: best.content,
      category: candidate.category,
    };
  }

  // Genuinely new: make room if we're at the cap, then insert.
  await enforceCap(userId, memoryCap);
  const doc = buildMemoryDoc({
    userId,
    role,
    candidate,
    embedding,
    sourceConversationId,
  });
  const inserted = await col.insertOne(doc);
  const newId = inserted.insertedId;
  if (!newId) throw new Error("Memory insert returned no id.");
  return {
    action: "created",
    memoryId: newId.toString(),
    content: candidate.content,
    category: candidate.category,
  };
}
