import { ObjectId } from "mongodb";
import {
  AppError,
  type Conversation,
  conversationsCol,
  deleteThreadCheckpoints,
  jobsCol,
  type Role,
} from "@claudius/shared";
import { deleteConversationDocuments } from "@/lib/documents";

/**
 * All conversation reads and writes funnel through here, and every one of them
 * filters by `userId` (CLAUDE.md invariant #1: no route or tool may return
 * another user's conversations). The functions take the owner's id explicitly so
 * that filtering is impossible to forget at a call site.
 */

/** Guest conversations live for 24h, then the TTL index reaps them. */
const GUEST_TTL_MS = 24 * 60 * 60 * 1000;

const PREVIEW_MAX = 140;

/** A conversation as the sidebar needs it: metadata only, no transcript. */
export interface ConversationSummary {
  id: string;
  title: string;
  modelId: string;
  archived: boolean;
  updatedAt: string;
  lastMessagePreview: string | null;
  /** Normalized to a real boolean here; absent in the document means false. */
  incognito: boolean;
}

function toSummary(doc: Conversation): ConversationSummary {
  return {
    id: doc._id!.toString(),
    title: doc.title,
    modelId: doc.modelId,
    archived: doc.archived,
    updatedAt: doc.updatedAt.toISOString(),
    lastMessagePreview: doc.lastMessagePreview ?? null,
    incognito: doc.incognito === true,
  };
}

/**
 * Create a fresh conversation for the first message of a new thread. Guests get
 * an `expiresAt` so their data is ephemeral by construction (invariant #4);
 * members and admins omit the field entirely so the TTL never touches them.
 */
export async function createConversation(params: {
  userId: ObjectId;
  role: Role;
  modelId: string;
  /**
   * Set only when the caller asked for an incognito thread AND the role may have
   * one. Creation is the only moment the flag can ever be set: it is not part of
   * any update path, so an existing conversation can never become incognito or
   * stop being it.
   */
  incognito?: boolean;
}): Promise<Conversation> {
  const now = new Date();
  const base: Conversation = {
    userId: params.userId,
    title: "New chat",
    modelId: params.modelId,
    createdAt: now,
    updatedAt: now,
    archived: false,
    // Same omit-don't-set-undefined discipline as expiresAt below: absent is the
    // normal state, and `literal(true)` makes an explicit false a type error.
    ...(params.incognito ? { incognito: true as const } : {}),
  };
  // Omit (not set undefined) expiresAt for non-guests: with
  // exactOptionalPropertyTypes the key's absence is what keeps the TTL away.
  const doc: Conversation =
    params.role === "guest"
      ? { ...base, expiresAt: new Date(now.getTime() + GUEST_TTL_MS) }
      : base;

  const col = await conversationsCol();
  const result = await col.insertOne(doc);
  return { ...doc, _id: result.insertedId };
}

/**
 * Load a conversation only if it belongs to this user. Returns null when it is
 * missing or owned by someone else — callers treat both the same (404), never
 * revealing that another user's conversation exists.
 */
export async function getOwnedConversation(
  userId: ObjectId,
  conversationId: string,
): Promise<Conversation | null> {
  if (!ObjectId.isValid(conversationId)) return null;
  const col = await conversationsCol();
  return col.findOne({ _id: new ObjectId(conversationId), userId });
}

/** The user's conversations, most recently active first. */
export async function listConversations(
  userId: ObjectId,
): Promise<ConversationSummary[]> {
  const col = await conversationsCol();
  const docs = await col
    .find({ userId })
    .sort({ updatedAt: -1 })
    .limit(200)
    .toArray();
  return docs.map(toSummary);
}

/** Record activity on a turn: bump updatedAt, refresh the preview, persist model. */
export async function touchConversation(params: {
  userId: ObjectId;
  conversationId: ObjectId;
  preview: string;
  modelId: string;
}): Promise<void> {
  const col = await conversationsCol();
  await col.updateOne(
    { _id: params.conversationId, userId: params.userId },
    {
      $set: {
        updatedAt: new Date(),
        lastMessagePreview: params.preview.slice(0, PREVIEW_MAX),
        modelId: params.modelId,
      },
    },
  );
}

export async function setConversationTitle(
  userId: ObjectId,
  conversationId: ObjectId,
  title: string,
): Promise<void> {
  const col = await conversationsCol();
  await col.updateOne(
    { _id: conversationId, userId },
    { $set: { title } },
  );
}

/** Archive or unarchive, scoped to the owner. Throws 404 if not theirs. */
export async function setArchived(
  userId: ObjectId,
  conversationId: string,
  archived: boolean,
): Promise<ConversationSummary> {
  if (!ObjectId.isValid(conversationId)) {
    throw new AppError("not_found", "Conversation not found.");
  }
  const col = await conversationsCol();
  const updated = await col.findOneAndUpdate(
    { _id: new ObjectId(conversationId), userId },
    { $set: { archived } },
    { returnDocument: "after" },
  );
  if (!updated) {
    throw new AppError("not_found", "Conversation not found.");
  }
  return toSummary(updated);
}

/**
 * Permanently delete a conversation and everything that hangs off it: its
 * attached documents (records, chunks and raw bytes), its jobs, its entire
 * checkpointed transcript, and finally the conversation row itself.
 *
 * Children go first and the parent last, deliberately. MongoDB gives us no
 * transaction across these collections, so a failure part way through has to
 * leave SOMETHING recoverable, and the recoverable state is the one where the
 * conversation still exists and the delete can simply be retried. Deleting the
 * row first would strip the only handle the user has on the leftovers.
 *
 * Two things are deliberately NOT deleted. `usage_events` rows survive: they
 * hold token counts, never content, and they back the daily cap, the monthly
 * budget and the admin aggregates, all of which would silently drift if history
 * could be erased by deleting a chat. Memories extracted from the thread survive
 * too: they are separately visible and deletable under /memories, and deleting a
 * conversation is a request to drop the transcript, not to unlearn the facts it
 * taught. (An incognito thread never produces any, so this only ever applies to
 * a normal one.)
 */
export async function deleteConversation(
  userId: ObjectId,
  conversationId: string,
): Promise<void> {
  if (!ObjectId.isValid(conversationId)) {
    throw new AppError("not_found", "Conversation not found.");
  }
  const _id = new ObjectId(conversationId);
  const col = await conversationsCol();
  // Ownership check and the delete are separate steps, so read first: the
  // cascade below needs the id, and a non-owned id must 404 before anything is
  // removed.
  const owned = await col.findOne({ _id, userId });
  if (!owned) {
    throw new AppError("not_found", "Conversation not found.");
  }

  await deleteConversationDocuments(userId, _id);

  const jobs = await jobsCol();
  await jobs.deleteMany({ userId, conversationId: _id });

  await deleteThreadCheckpoints(conversationId);

  await col.deleteOne({ _id, userId });
}

export { toSummary };
