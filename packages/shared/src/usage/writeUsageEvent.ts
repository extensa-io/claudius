import type { ObjectId } from "mongodb";
import { usageEventsCol } from "../db/collections";
import { type UsageEvent, UsageEventSchema } from "../db/schemas";

/**
 * The shape a caller hands us: flat token counts plus the dimensions, with the
 * meta-nesting and timestamp left to this function so call sites never have to
 * know the time-series document layout.
 */
export interface UsageEventInput {
  userId: ObjectId;
  conversationId: ObjectId | null;
  modelId: string;
  purpose: UsageEvent["meta"]["purpose"];
  inputTokens: number;
  outputTokens: number;
  /** Prompt-cache reads. Always 0 until caching arrives (Phase 1 omits it). */
  cacheReadTokens?: number;
  latencyMs: number;
}

/**
 * Append one billable model call to the `usage_events` time-series collection.
 *
 * This is the single writer for usage telemetry (CLAUDE.md invariant: every
 * Bedrock invocation writes a usage_events document with token counts). It
 * validates against the schema before inserting so a malformed event fails here,
 * at the boundary, rather than corrupting the metrics the admin views later read.
 */
export async function writeUsageEvent(input: UsageEventInput): Promise<void> {
  const event: UsageEvent = UsageEventSchema.parse({
    meta: {
      userId: input.userId,
      modelId: input.modelId,
      purpose: input.purpose,
    },
    conversationId: input.conversationId,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    cacheReadTokens: input.cacheReadTokens ?? 0,
    latencyMs: input.latencyMs,
    timestamp: new Date(),
  });

  const col = await usageEventsCol();
  await col.insertOne(event);
}
