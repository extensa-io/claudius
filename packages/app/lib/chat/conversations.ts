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

/**
 * A guest conversation is meant to last 24h. `expiresAt` is stored an hour
 * beyond that on purpose, because two things can delete it and they are not
 * equivalent.
 *
 * The sweep is the one we want: it runs the full cascade, so the thread's
 * checkpoints and jobs go with it. The TTL index on `expiresAt` is the backstop:
 * it deletes only the conversation row and orphans the rest, which is how three
 * dead threads came to be holding 56 checkpoints between them.
 *
 * MongoDB's TTL reaper wakes every 60 seconds and the sweep runs hourly, so a
 * date they both target would go to the TTL essentially every time. Storing it
 * an hour late and having the sweep claim guest threads once they are within an
 * hour of it (SWEEP_LOOKAHEAD_MS) gives the sweep a full hour of exclusive
 * window. Effective guest lifetime is unchanged at roughly 24h, and invariant #4
 * still holds: the database, not the cron, is what guarantees the data goes.
 */
const GUEST_TTL_MS = 25 * 60 * 60 * 1000;

/** How far ahead of `expiresAt` the sweep claims a guest thread. */
const SWEEP_LOOKAHEAD_MS = 60 * 60 * 1000;

/**
 * A scratch thread (operator lookups only) lapses 24h after its LAST turn, not
 * after its creation: the clock is pushed forward on every lookup, so a thread
 * you keep coming back to survives and one you abandon disappears.
 */
const SCRATCH_TTL_MS = 24 * 60 * 60 * 1000;

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
  /** When this scratch thread lapses; null for a normal conversation. */
  scratchUntil: string | null;
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
    scratchUntil: doc.scratchUntil ? doc.scratchUntil.toISOString() : null,
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
  /**
   * Set by the operator engines (dictionary, quote, translate) so the thread
   * starts life as scratch and lapses unless it earns a real question.
   */
  scratch?: boolean;
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
    ...(params.scratch
      ? { scratchUntil: new Date(now.getTime() + SCRATCH_TTL_MS) }
      : {}),
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

/**
 * Record activity on a turn: bump updatedAt, refresh the preview, persist model.
 *
 * Also the single place a thread's scratch status changes. An operator lookup
 * pushes the lapse date forward; anything else clears it, promoting the thread to
 * a real conversation for good.
 */
export async function touchConversation(params: {
  userId: ObjectId;
  conversationId: ObjectId;
  preview: string;
  modelId: string;
  /** True when this turn was an operator lookup (`?`, `$`, `&`). */
  scratch?: boolean;
}): Promise<void> {
  const col = await conversationsCol();
  const filter = { _id: params.conversationId, userId: params.userId };
  const $set = {
    updatedAt: new Date(),
    lastMessagePreview: params.preview.slice(0, PREVIEW_MAX),
    modelId: params.modelId,
  };

  if (!params.scratch) {
    // A real question promotes the thread. $unset on a document that never had
    // the field is a no-op, so this needs no guard and no branch on the current
    // state. Note it clears ONLY scratchUntil: a guest's expiresAt stays put, so
    // promoting a thread never makes guest data permanent (invariant #4).
    await col.updateOne(filter, { $set, $unset: { scratchUntil: "" } });
    return;
  }

  await col.updateOne(filter, { $set });
  // Refreshing the clock is a separate, guarded write: the $exists check means a
  // `?` lookup typed inside an already-promoted thread cannot re-arm the timer
  // and schedule a real conversation for deletion. Promotion is one-way.
  await col.updateOne(
    { ...filter, scratchUntil: { $exists: true } },
    { $set: { scratchUntil: new Date(Date.now() + SCRATCH_TTL_MS) } },
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

/** How many lapsed threads one sweep will clear, so a run stays bounded. */
const SWEEP_LIMIT = 500;

/**
 * Delete every conversation that has run out of time: scratch threads whose
 * lapse date has passed, and guest threads about to hit their `expiresAt`.
 *
 * Both kinds exist because MongoDB's TTL reaper removes only the document it
 * matches. A conversation is the root of a small tree — attached documents and
 * their chunks, jobs, and the entire checkpointed transcript — so a bare TTL
 * deletes the row and leaves the rest behind with nothing pointing at it. Routing
 * through deleteConversation reuses the same cascade the delete button uses.
 *
 * The two dates are treated differently for one reason. `scratchUntil` carries no
 * TTL index, so the sweep is its only reaper and "already lapsed" is the right
 * question. `expiresAt` does carry one, and that reaper wakes every 60 seconds
 * against this sweep's hourly run, so the sweep has to get there first: it claims
 * a guest thread as soon as it is within SWEEP_LOOKAHEAD_MS of the stored date,
 * which is itself an hour past the 24h the guest is actually promised.
 *
 * The find is intentionally NOT scoped to one user: this is a system sweep, not
 * a user-facing read, so invariant #1 does not apply to it. Every delete still
 * passes the owning userId back into the cascade, so an ownership bug here
 * cannot cross accounts.
 *
 * One conversation failing must not strand the rest, so failures are logged and
 * skipped. The row keeps its lapsed date and is retried on the next run — or, for
 * a guest thread the sweep keeps failing on, the TTL backstop eventually takes it.
 */
export async function sweepExpiredThreads(): Promise<{
  deleted: number;
  failed: number;
}> {
  const col = await conversationsCol();
  const now = Date.now();
  const lapsed = await col
    .find({
      $or: [
        { scratchUntil: { $lte: new Date(now) } },
        { expiresAt: { $lte: new Date(now + SWEEP_LOOKAHEAD_MS) } },
      ],
    })
    .limit(SWEEP_LIMIT)
    .toArray();

  let deleted = 0;
  let failed = 0;
  for (const doc of lapsed) {
    try {
      await deleteConversation(doc.userId, doc._id!.toString());
      deleted += 1;
    } catch (err) {
      failed += 1;
      console.error(
        `Expiry sweep failed for conversation ${doc._id!.toString()}:`,
        err instanceof Error ? `${err.name}: ${err.message}` : err,
      );
    }
  }
  return { deleted, failed };
}

export { toSummary };
