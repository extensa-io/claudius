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
