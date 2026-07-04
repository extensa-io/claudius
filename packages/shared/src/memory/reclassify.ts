import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { z } from "zod";
import { buildChatModel } from "../agent/model";
import { memoriesCol } from "../db/collections";
import type { User } from "../db/schemas";
import { assertCanInvoke } from "../tiers";
import { writeUsageEvent } from "../usage";

/**
 * One-time salience backfill (Phase 6). Phase 3 stored memories with no
 * importance, so the always-on profile and salience-weighted retrieval have
 * nothing to rank by on an existing store. This assigns a real 0..1 importance
 * to each pre-Phase-6 memory with a cheap Haiku pass, using the SAME rubric as
 * extraction so old and new memories are scored on one scale.
 *
 * Idempotency marker is the field's PRESENCE: this only touches rows where
 * `importance` is missing, so a re-run (after the migration's fallback backfill
 * fills any stragglers to neutral) finds nothing and makes no model call. Routed
 * through `assertCanInvoke` (invariant #3: every Bedrock call passes the tier
 * gate) as a system call — `consumeDailyMessage: false` — and writes one
 * `memory_reclassify` usage_events row per batch with the token counts.
 */

const RECLASSIFY_MODEL_ID = "haiku";
const RECLASSIFY_BATCH = 50;

const RECLASSIFY_SYSTEM = `You assign an importance score to each stored memory about a user. Importance is 0 to 1: how central this is to who the user is, independent of anything else.
- 0.8 to 1.0: defining identity — role or profession, where they live, languages they speak, their name, the core of what they work on.
- 0.4 to 0.7: durable but ordinary — a tool preference, an ongoing project, a habit.
- 0.0 to 0.3: real but minor — an incidental detail that rarely shapes how to help them.

You are given a numbered list of memories. Return ONLY a JSON object of the form:
{"scores":[{"i":0,"importance":0.0},{"i":1,"importance":0.0}]}
one entry per input index, importance between 0 and 1. No prose, no markdown fences.`;

const ScoresSchema = z.object({
  scores: z.array(
    z.object({ i: z.number().int().nonnegative(), importance: z.number() }),
  ),
});

/** Render the batch as a numbered list the model scores by index. */
export function buildReclassifyInput(
  memories: Array<{ content: string; category: string }>,
): string {
  return memories
    .map((m, i) => `[${i}] (${m.category}) ${m.content}`)
    .join("\n");
}

/**
 * Parse the model's reply into an importance per input index, or null where the
 * model gave nothing usable. Pure so the scoring contract is unit-testable
 * without a live model. Out-of-range values are clamped to [0, 1]; a missing or
 * malformed reply yields all-null (those rows get the neutral fallback later).
 */
export function parseImportanceScores(
  raw: string,
  count: number,
): Array<number | null> {
  const out: Array<number | null> = new Array(count).fill(null);
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return out;
  let json: unknown;
  try {
    json = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return out;
  }
  const parsed = ScoresSchema.safeParse(json);
  if (!parsed.success) return out;
  for (const { i, importance } of parsed.data.scores) {
    if (i < count) out[i] = Math.min(1, Math.max(0, importance));
  }
  return out;
}

export interface ReclassifyResult {
  reclassified: number;
}

/**
 * Assign importance to one user's un-scored memories. Owner-scoped throughout
 * (invariant #1). Batched so the prompt stays bounded; each batch is one gated
 * model call plus one usage_events row.
 */
export async function reclassifyUserMemories(params: {
  user: User;
}): Promise<ReclassifyResult> {
  const { user } = params;
  const userId = user._id!;
  const col = await memoriesCol();

  // Only rows that were never scored — presence of `importance` is the marker.
  const unscored = (await col
    .find({ userId, importance: { $exists: false } })
    .project({ _id: 1, content: 1, category: 1 })
    .toArray()) as Array<{ _id: import("mongodb").ObjectId; content: string; category: string }>;

  if (unscored.length === 0) return { reclassified: 0 };

  let reclassified = 0;
  for (let offset = 0; offset < unscored.length; offset += RECLASSIFY_BATCH) {
    const batch = unscored.slice(offset, offset + RECLASSIFY_BATCH);

    const grant = await assertCanInvoke(userId, RECLASSIFY_MODEL_ID, {
      consumeDailyMessage: false,
    });
    const model = buildChatModel(grant.inferenceProfileId, {
      maxTokens: 2048,
      temperature: 0,
    });

    const startedAt = Date.now();
    const response = await model.invoke([
      new SystemMessage(RECLASSIFY_SYSTEM),
      new HumanMessage(buildReclassifyInput(batch)),
    ]);
    const latencyMs = Date.now() - startedAt;

    const usage = response.usage_metadata as
      | { input_tokens?: number; output_tokens?: number }
      | undefined;
    await writeUsageEvent({
      userId,
      conversationId: null,
      modelId: grant.modelId,
      purpose: "memory_reclassify",
      inputTokens: usage?.input_tokens ?? 0,
      outputTokens: usage?.output_tokens ?? 0,
      latencyMs,
    });

    const scores = parseImportanceScores(response.text, batch.length);
    for (let i = 0; i < batch.length; i += 1) {
      const importance = scores[i];
      // Null (model gave nothing) or undefined (index gap) both skip.
      if (importance == null) continue;
      await col.updateOne(
        { _id: batch[i]!._id, userId },
        { $set: { importance } },
      );
      reclassified += 1;
    }
  }

  return { reclassified };
}
