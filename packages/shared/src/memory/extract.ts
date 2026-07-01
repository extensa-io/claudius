import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { ObjectId } from "mongodb";
import { buildChatModel } from "../agent/model";
import { assertCanInvoke } from "../tiers";
import { writeUsageEvent } from "../usage";
import {
  type MemoryCandidate,
  ExtractionOutputSchema,
} from "./types";

/**
 * Turn the new turns of a conversation into candidate memories with a cheap
 * Haiku pass. This is the read side of Phase 3's extraction pipeline; dedup,
 * supersession, caps, and persistence happen in persist.ts.
 *
 * We route through `assertCanInvoke` (invariant #3: every Bedrock call passes the
 * tier gate) as a system call — `consumeDailyMessage: false` — because extraction
 * is not a turn the user typed, then write one `memory_extraction` usage_events
 * row with the token counts.
 */

/** Cheapest catalog model, permitted for every role. */
const EXTRACTION_MODEL_ID = "haiku";

/**
 * Candidates below this confidence are discarded. The threshold is what makes
 * "small talk produces zero memories" true: the model rates an offhand "thanks!"
 * far below a durable "I'm migrating our test suite to Vitest".
 */
export const CONFIDENCE_THRESHOLD = 0.6;

const EXTRACTION_SYSTEM = `You extract durable, long-term memories about the USER from a conversation with an AI assistant.

A memory is a stable fact, preference, or piece of context that would still be useful weeks from now in a completely different conversation. Examples: the user's role or location, tools and workflows they prefer, ongoing projects, constraints they operate under, people or systems they mention repeatedly.

Do NOT record:
- Small talk, greetings, thanks, or pleasantries.
- Anything the assistant said about itself.
- One-off task details that won't matter later (a specific question, a transient value, today's error message).
- Speculation. Only record what the user actually stated or clearly implied.

Classify each memory:
- "fact": an objective, durable truth about the user or their world.
- "preference": something they like, dislike, or choose to do.
- "context": ongoing situation or background that frames future help.

For each memory set "confidence" from 0 to 1: how sure you are it is durable and worth remembering. Be strict; when in doubt, lower it.

Write each memory as a short third-person statement about the user (for example "Prefers Vitest over Jest for testing"). Merge duplicates. If nothing is worth remembering, return an empty list.

Respond with ONLY a JSON object of the form:
{"memories":[{"content":"...","category":"fact|preference|context","confidence":0.0}]}
No prose, no markdown fences.`;

interface UsageMetadata {
  input_tokens?: number;
  output_tokens?: number;
  input_token_details?: { cache_read?: number };
}

/**
 * Pull the first JSON object out of the model's reply. Haiku is asked for raw
 * JSON, but a stray markdown fence or a leading sentence shouldn't lose the whole
 * extraction — we slice from the first `{` to the last `}` and let Zod validate.
 */
function parseCandidates(raw: string): MemoryCandidate[] {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return [];
  let json: unknown;
  try {
    json = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  const parsed = ExtractionOutputSchema.safeParse(json);
  if (!parsed.success) return [];
  return parsed.data.memories;
}

/**
 * Parse the model's reply and keep only high-confidence candidates. Exposed as a
 * pure function so the confidence filter — the thing that makes "small talk
 * produces zero memories" true — is unit-testable without a live model call.
 */
export function selectCandidates(raw: string): MemoryCandidate[] {
  return parseCandidates(raw).filter(
    (c) => c.confidence >= CONFIDENCE_THRESHOLD,
  );
}

/**
 * Run extraction over a formatted transcript of only the NEW turns. Returns the
 * high-confidence candidates. Any model or parse failure yields an empty list:
 * a missed extraction is a soft failure (the next run retries), never an error
 * that should break a chat or a cron sweep.
 */
export async function extractCandidates(params: {
  userId: ObjectId;
  conversationId: ObjectId;
  transcript: string;
}): Promise<MemoryCandidate[]> {
  const grant = await assertCanInvoke(params.userId, EXTRACTION_MODEL_ID, {
    consumeDailyMessage: false,
  });

  // Haiku accepts temperature; 0 keeps extraction deterministic across runs.
  const model = buildChatModel(grant.inferenceProfileId, {
    maxTokens: 1024,
    temperature: 0,
  });

  const startedAt = Date.now();
  const response = await model.invoke([
    new SystemMessage(EXTRACTION_SYSTEM),
    new HumanMessage(params.transcript),
  ]);
  const latencyMs = Date.now() - startedAt;

  const usage = response.usage_metadata as UsageMetadata | undefined;
  await writeUsageEvent({
    userId: params.userId,
    conversationId: params.conversationId,
    modelId: grant.modelId,
    purpose: "memory_extraction",
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    cacheReadTokens: usage?.input_token_details?.cache_read ?? 0,
    latencyMs,
  });

  return selectCandidates(response.text);
}
