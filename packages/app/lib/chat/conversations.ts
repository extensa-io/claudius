import { ObjectId } from "mongodb";
import {
  AppError,
  type Conversation,
  conversationsCol,
  type Role,
} from "@claudius/shared";

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
}

function toSummary(doc: Conversation): ConversationSummary {
  return {
    id: doc._id!.toString(),
    title: doc.title,
    modelId: doc.modelId,
    archived: doc.archived,
    updatedAt: doc.updatedAt.toISOString(),
    lastMessagePreview: doc.lastMessagePreview ?? null,
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
}): Promise<Conversation> {
  const now = new Date();
  const base: Conversation = {
    userId: params.userId,
    title: "New chat",
    modelId: params.modelId,
    createdAt: now,
    updatedAt: now,
    archived: false,
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

export { toSummary };
