import { z } from "zod";
import { zObjectId } from "./common";

/** The three kinds of thing Claudius remembers. Single source for the enum. */
export const MemoryCategorySchema = z.enum(["fact", "preference", "context"]);
export type MemoryCategory = z.infer<typeof MemoryCategorySchema>;

/**
 * A durable fact, preference, or piece of context the agent learned about a
 * user. `embedding` is a 1024-dim Voyage vector used by Atlas Vector Search
 * (the index pre-filters on `userId`, never post-filters — invariant).
 *
 * `supersededBy` forms a chain: when a newer memory replaces this one, it
 * points forward to the replacement, which is what powers the "↳ replaced an
 * earlier memory" affordance in the memory UI. `expiresAt` is guests-only,
 * same TTL contract as conversations.
 */
export const MemorySchema = z.object({
  _id: zObjectId.optional(),
  userId: zObjectId,
  content: z.string(),
  category: MemoryCategorySchema,
  embedding: z.array(z.number()),
  sourceConversationId: zObjectId,
  createdAt: z.date(),
  lastAccessedAt: z.date(),
  supersededBy: zObjectId.nullable(),
  expiresAt: z.date().optional(),
});

export type Memory = z.infer<typeof MemorySchema>;
