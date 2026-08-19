import { z } from "zod";
import { zObjectId } from "./common";

/**
 * One billable model call, stored in a MongoDB time-series collection.
 *
 * Time-series collections want a single `metaField` holding the low-cardinality
 * dimensions you group and filter by, with the measurements alongside. We nest
 * userId/modelId/purpose under `meta` and keep the token counts and latency as
 * top-level measurements. `timestamp` is the time field. This shape lets us
 * answer "tokens per user per model per day" cheaply for the admin usage views.
 */
export const UsageEventMetaSchema = z.object({
  userId: zObjectId,
  modelId: z.string(),
  // `memory_reclassify` (Phase 6) is the one-time salience backfill's model
  // spend, kept distinct from ongoing `memory_extraction` so the admin dashboard
  // can tell a migration burst apart from steady-state extraction cost.
  purpose: z.enum([
    "chat",
    "research",
    "memory_extraction",
    "memory_reclassify",
    "title_gen",
    // Phase 10: a `?` dictionary define/translate turn. Kept distinct from
    // `chat` so the admin dashboard can size dictionary spend on its own.
    "dictionary",
    // Phase 14: a `&` translate turn. Distinct from `dictionary` so the admin
    // dashboard can size the two operators' spend separately.
    "translation",
  ]),
  /**
   * How many images this turn sent (Phase 12). Lives under `meta` so the admin
   * usage view can isolate image-bearing turns, whose input-token profile is
   * nothing like a text turn's — roughly 1600 tokens per image at 1568px, so a
   * three-image turn dwarfs the question attached to it. Optional (absent on
   * every pre-Phase-12 event) and low-cardinality, so it costs the time-series
   * bucketing nothing.
   */
  imageCount: z.number().int().nonnegative().optional(),
});

export const UsageEventSchema = z.object({
  _id: zObjectId.optional(),
  meta: UsageEventMetaSchema,
  conversationId: zObjectId.nullable(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  latencyMs: z.number().nonnegative(),
  timestamp: z.date(),
});

export type UsageEvent = z.infer<typeof UsageEventSchema>;
