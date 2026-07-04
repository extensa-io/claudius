import { ObjectId } from "mongodb";
import { conversationsCol, memoriesCol, usersCol } from "../db/collections";
import type { Memory, MemoryCategory } from "../db/schemas";
import { embedTexts } from "../embeddings/voyage";

/**
 * Read/write helpers behind the /memories UI. Every function takes the owner id
 * and filters by it (invariant #1): the memory views are user-scoped, and admin
 * never reads another user's memory content (invariant #6). Editing re-embeds so
 * a corrected memory stays retrievable by its new wording.
 */

export type MemorySort = "newest" | "oldest" | "last_used" | "important";

/** A predecessor in a supersession chain, for the "replaced an earlier" pill.
 * `reason` (Phase 6) tells an update apart from a consolidation merge, so the UI
 * can label lineage "replaced" vs "merged in". Absent rows read as "update". */
export interface SupersededRef {
  id: string;
  content: string;
  replacedAt: string;
  reason: "update" | "merge";
  sourceConversationTitle: string | null;
}

/** A memory as the /memories page renders it. */
export interface MemoryView {
  id: string;
  content: string;
  category: MemoryCategory;
  /** 0..1 salience: drives retrieval ranking and profile membership (Phase 6). */
  importance: number;
  createdAt: string;
  lastAccessedAt: string;
  sourceConversationId: string;
  sourceConversationTitle: string | null;
  /** Immediate predecessor(s) this memory replaced or merged, if any. */
  supersedes: SupersededRef[];
}

export interface ListMemoriesOptions {
  category?: MemoryCategory;
  sort?: MemorySort;
  search?: string;
}

const LIST_LIMIT = 500;

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sortSpec(sort: MemorySort): Record<string, 1 | -1> {
  switch (sort) {
    case "oldest":
      return { createdAt: 1 };
    case "last_used":
      return { lastAccessedAt: -1 };
    // Most defining first, newest breaking ties — mirrors the profile's order.
    case "important":
      return { importance: -1, createdAt: -1 };
    case "newest":
    default:
      return { createdAt: -1 };
  }
}

async function titlesFor(
  userId: ObjectId,
  conversationIds: ObjectId[],
): Promise<Map<string, string>> {
  if (conversationIds.length === 0) return new Map();
  const col = await conversationsCol();
  const docs = await col
    .find(
      { _id: { $in: conversationIds }, userId },
      { projection: { title: 1 } },
    )
    .toArray();
  return new Map(docs.map((d) => [d._id!.toString(), d.title]));
}

/**
 * The user's active (non-superseded) memories, newest first by default. Search
 * is a plain case-insensitive substring over content — deliberately NOT vector
 * search, so "do I remember anything about X" is literal and predictable.
 */
export async function listMemories(
  userId: ObjectId,
  options: ListMemoriesOptions = {},
): Promise<MemoryView[]> {
  const col = await memoriesCol();
  const filter: Record<string, unknown> = { userId, supersededBy: null };
  if (options.category) filter.category = options.category;
  if (options.search && options.search.trim().length > 0) {
    filter.content = { $regex: escapeRegex(options.search.trim()), $options: "i" };
  }

  const memories = await col
    .find(filter)
    .sort(sortSpec(options.sort ?? "newest"))
    .limit(LIST_LIMIT)
    .toArray();

  const memoryIds = memories.map((m) => m._id!);
  // Immediate predecessors: memories pointing at any listed memory.
  const predecessors =
    memoryIds.length > 0
      ? await col.find({ userId, supersededBy: { $in: memoryIds } }).toArray()
      : [];

  const predecessorsByNewId = new Map<string, Memory[]>();
  for (const pred of predecessors) {
    const key = pred.supersededBy!.toString();
    const list = predecessorsByNewId.get(key) ?? [];
    list.push(pred);
    predecessorsByNewId.set(key, list);
  }

  // Resolve conversation titles for both the memories and their predecessors.
  const convIds = new Set<string>();
  for (const m of [...memories, ...predecessors]) {
    convIds.add(m.sourceConversationId.toString());
  }
  const titles = await titlesFor(
    userId,
    [...convIds].map((id) => new ObjectId(id)),
  );

  return memories.map((m) => {
    const id = m._id!.toString();
    const supersedes = (predecessorsByNewId.get(id) ?? []).map((p) => ({
      id: p._id!.toString(),
      content: p.content,
      // The predecessor was replaced when this memory was created.
      replacedAt: m.createdAt.toISOString(),
      reason: p.supersededReason ?? "update",
      sourceConversationTitle:
        titles.get(p.sourceConversationId.toString()) ?? null,
    }));
    return {
      id,
      content: m.content,
      category: m.category,
      importance: m.importance ?? 0.5,
      createdAt: m.createdAt.toISOString(),
      lastAccessedAt: m.lastAccessedAt.toISOString(),
      sourceConversationId: m.sourceConversationId.toString(),
      sourceConversationTitle:
        titles.get(m.sourceConversationId.toString()) ?? null,
      supersedes,
    };
  });
}

/**
 * Walk the full supersession chain behind a memory, newest predecessor first.
 * Each hop is "the memory that this one replaced". Bounded so a cyclic pointer
 * (should never happen) can't loop forever.
 */
export async function getSupersessionChain(
  userId: ObjectId,
  memoryId: string,
): Promise<SupersededRef[]> {
  if (!ObjectId.isValid(memoryId)) return [];
  const col = await memoriesCol();
  const chain: SupersededRef[] = [];
  let currentId = new ObjectId(memoryId);

  for (let hop = 0; hop < 50; hop += 1) {
    const predecessor = await col.findOne({
      userId,
      supersededBy: currentId,
    });
    if (!predecessor?._id) break;
    const title = await titlesFor(userId, [predecessor.sourceConversationId]);
    chain.push({
      id: predecessor._id.toString(),
      content: predecessor.content,
      replacedAt: predecessor.lastAccessedAt.toISOString(),
      reason: predecessor.supersededReason ?? "update",
      sourceConversationTitle:
        title.get(predecessor.sourceConversationId.toString()) ?? null,
    });
    currentId = predecessor._id;
  }
  return chain;
}

/**
 * Edit a memory's content and re-embed it so retrieval matches the new wording.
 * Scoped to the owner; returns false if the memory isn't theirs (or is missing).
 */
export async function editMemory(
  userId: ObjectId,
  memoryId: string,
  content: string,
): Promise<boolean> {
  const trimmed = content.trim();
  if (!ObjectId.isValid(memoryId) || trimmed.length === 0) return false;
  const [embedding] = await embedTexts([trimmed]);
  if (!embedding) return false;
  const col = await memoriesCol();
  const result = await col.updateOne(
    { _id: new ObjectId(memoryId), userId },
    { $set: { content: trimmed, embedding } },
  );
  return result.matchedCount > 0;
}

/**
 * Set a memory's importance (Phase 6). Clamped to [0, 1]; no re-embed needed
 * since salience doesn't change the vector, only the ranking blend and profile
 * membership. Owner-scoped; false if the memory isn't theirs. This is what makes
 * "raise a memory's importance and watch its ranking change" a user action.
 */
export async function setImportance(
  userId: ObjectId,
  memoryId: string,
  importance: number,
): Promise<boolean> {
  if (!ObjectId.isValid(memoryId)) return false;
  const clamped = Math.min(1, Math.max(0, importance));
  const col = await memoriesCol();
  const result = await col.updateOne(
    { _id: new ObjectId(memoryId), userId },
    { $set: { importance: clamped } },
  );
  return result.matchedCount > 0;
}

/** Delete a memory. Scoped to the owner; false if it isn't theirs. */
export async function deleteMemory(
  userId: ObjectId,
  memoryId: string,
): Promise<boolean> {
  if (!ObjectId.isValid(memoryId)) return false;
  const col = await memoriesCol();
  const result = await col.deleteOne({ _id: new ObjectId(memoryId), userId });
  return result.deletedCount > 0;
}

export interface MemorySettings {
  enabled: boolean;
  count: number;
}

/** The memory master switch plus the active memory count, for the page header. */
export async function getMemorySettings(
  userId: ObjectId,
): Promise<MemorySettings> {
  const users = await usersCol();
  const user = await users.findOne(
    { _id: userId },
    { projection: { memoryEnabled: 1 } },
  );
  const col = await memoriesCol();
  const count = await col.countDocuments({ userId, supersededBy: null });
  return { enabled: user?.memoryEnabled ?? true, count };
}

/** Flip the memory master switch for a user. */
export async function setMemoryEnabled(
  userId: ObjectId,
  enabled: boolean,
): Promise<void> {
  const users = await usersCol();
  await users.updateOne({ _id: userId }, { $set: { memoryEnabled: enabled } });
}
