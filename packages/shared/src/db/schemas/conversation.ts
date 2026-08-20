import { z } from "zod";
import { zObjectId } from "./common";

/**
 * `expiresAt` is present only on guest-owned conversations. A TTL index on the
 * field (see indexes.ts) lets MongoDB delete guest data automatically once it
 * lapses, so ephemerality is enforced by the database rather than by app code.
 * Member and admin documents omit the field entirely (with
 * exactOptionalPropertyTypes on, we never set it to `undefined` — we leave the
 * key off), so the TTL never touches their data.
 */
export const ConversationSchema = z.object({
  _id: zObjectId.optional(),
  userId: zObjectId,
  title: z.string(),
  modelId: z.string(),
  createdAt: z.date(),
  updatedAt: z.date(),
  archived: z.boolean(),
  // A short denormalized snippet of the latest turn, kept current on every
  // message. The sidebar lists conversations straight from this collection; the
  // actual transcript lives in the checkpointer, and loading each thread's state
  // just to render a one-line preview would be far too expensive. Duplicating a
  // truncated copy here is the classic "store what you render" tradeoff.
  lastMessagePreview: z.string().optional(),
  expiresAt: z.date().optional(),
  /**
   * Incognito threads read no persisted personal context (no memories, no
   * user-authored instructions) and are never mined for new ones. The flag is
   * fixed when the conversation is created and never changes, so every turn in
   * the thread ran under the same rules — a mid-thread toggle would leave a
   * transcript where some answers saw context and some didn't, with nothing to
   * tell them apart.
   *
   * Typed `literal(true)` rather than `boolean` so `false` is unrepresentable:
   * a normal conversation omits the key entirely, which means there is exactly
   * one shape to query for and the `{ $ne: true }` extraction filter matches
   * every document written before this field existed, with no backfill.
   */
  incognito: z.literal(true).optional(),
  /**
   * A scratch thread is one that has only ever held operator lookups (`?word`,
   * `$SYMBOL`, `&lang`). Those create a conversation row exactly like a real
   * chat does, and a sidebar full of one-off dictionary lookups buries the
   * threads that matter. The field carries both facts at once: the thread is
   * scratch while the key is present, and it lapses at the date inside it.
   *
   * Deliberately a separate field from `expiresAt` rather than a reuse, and
   * deliberately NOT under a TTL index. MongoDB's TTL reaper deletes only the
   * document it matches, so it would drop the conversation row and orphan the
   * thread's checkpoints, jobs and documents. An hourly cron sweep reads this
   * field instead and deletes through the full cascade. A guest scratch thread
   * therefore carries both fields: `expiresAt` for guest ephemerality
   * (invariant #4, enforced by the database) and this one for the sweep.
   *
   * The first normal message in the thread unsets it, permanently: asking a real
   * question is the signal that the thread is worth keeping.
   */
  scratchUntil: z.date().optional(),
  /**
   * Memory-extraction watermark (Phase 3). `lastRunAt` is when extraction last
   * processed this thread; `messageCount` is how many checkpointed messages had
   * been seen by then, so the next run extracts only the turns beyond it rather
   * than re-reading the whole transcript. Absent until the first extraction runs.
   */
  extraction: z
    .object({
      lastRunAt: z.date(),
      messageCount: z.number().int().nonnegative(),
    })
    .optional(),
});

export type Conversation = z.infer<typeof ConversationSchema>;
