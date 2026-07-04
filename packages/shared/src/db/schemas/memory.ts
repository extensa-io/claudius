import { z } from "zod";
import { zObjectId } from "./common";

/** The three kinds of thing Claudius remembers. Single source for the enum. */
export const MemoryCategorySchema = z.enum(["fact", "preference", "context"]);
export type MemoryCategory = z.infer<typeof MemoryCategorySchema>;

/**
 * Why one memory stopped being the current version (Phase 6). `update` is the
 * Phase 3 case: a newer statement in the SAME category replaced this fact.
 * `merge` is the Phase 6 consolidation case: this row was folded into a
 * near-duplicate that differed only by category or phrasing. Both keep the row
 * as an audit trail; the reason lets the UI show "replaced" vs "merged into"
 * lineage. Absent on rows superseded before Phase 6 (treated as `update`).
 */
export const SupersededReasonSchema = z.enum(["update", "merge"]);
export type SupersededReason = z.infer<typeof SupersededReasonSchema>;

/**
 * A durable fact, preference, or piece of context the agent learned about a
 * user. `embedding` is a 1024-dim Voyage vector used by Atlas Vector Search
 * (the index pre-filters on `userId`, never post-filters — invariant).
 *
 * `importance` (Phase 6) is a 0..1 salience score set at extraction time and
 * adjustable in the UI. Retrieval blends it with vector similarity so a defining
 * fact isn't crowded out of top-k by a trivial one that happens to phrase-match,
 * and the always-on profile is the user's highest-`importance` identity rows.
 * 0.5 is neutral; identity facts (role, location, languages, name) sit high.
 *
 * `supersededBy` forms a chain: when a newer memory replaces this one, it
 * points forward to the replacement, which is what powers the "↳ replaced an
 * earlier memory" affordance in the memory UI. `supersededReason` records
 * whether that was an update or a Phase 6 consolidation merge. `expiresAt` is
 * guests-only, same TTL contract as conversations.
 */
export const MemorySchema = z.object({
  _id: zObjectId.optional(),
  userId: zObjectId,
  content: z.string(),
  category: MemoryCategorySchema,
  importance: z.number().min(0).max(1),
  embedding: z.array(z.number()),
  sourceConversationId: zObjectId,
  createdAt: z.date(),
  lastAccessedAt: z.date(),
  supersededBy: zObjectId.nullable(),
  supersededReason: SupersededReasonSchema.optional(),
  expiresAt: z.date().optional(),
});

export type Memory = z.infer<typeof MemorySchema>;
