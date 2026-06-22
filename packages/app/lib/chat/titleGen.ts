import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { ObjectId } from "mongodb";
import {
  assertCanInvoke,
  buildChatModel,
  writeUsageEvent,
} from "@claudius/shared";
import { setConversationTitle } from "./conversations";

/** The model used for titles: cheapest in the catalog, allowed for every role. */
const TITLE_MODEL_ID = "haiku";

const TITLE_SYSTEM = `You write short conversation titles. Given the opening
exchange, reply with a 3 to 6 word title in Title Case. No quotes, no trailing
punctuation, no preamble — just the title.`;

interface UsageMetadata {
  input_tokens?: number;
  output_tokens?: number;
  input_token_details?: { cache_read?: number };
}

function cleanTitle(raw: string): string {
  return raw
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\s+/g, " ")
    .slice(0, 80);
}

/**
 * Fire-and-forget: after the first exchange of a new conversation completes,
 * generate a title with a cheap Haiku call and persist it. It still routes
 * through `assertCanInvoke` (invariant #3) and writes its own usage_events row
 * with purpose `title_gen`, but it does *not* consume the user's daily message
 * allowance — it is a system call, not a turn the user typed.
 *
 * Any failure here is swallowed: a missing title must never break a chat reply.
 */
export async function generateTitle(params: {
  userId: ObjectId;
  conversationId: ObjectId;
  userText: string;
  assistantText: string;
}): Promise<void> {
  try {
    const grant = await assertCanInvoke(params.userId, TITLE_MODEL_ID, {
      consumeDailyMessage: false,
    });

    const model = buildChatModel(grant.inferenceProfileId, {
      maxTokens: 24,
      temperature: 0.3,
    });

    const startedAt = Date.now();
    const response = await model.invoke([
      new SystemMessage(TITLE_SYSTEM),
      new HumanMessage(
        `User: ${params.userText}\n\nAssistant: ${params.assistantText}`,
      ),
    ]);
    const latencyMs = Date.now() - startedAt;

    const usage = response.usage_metadata as UsageMetadata | undefined;
    await writeUsageEvent({
      userId: params.userId,
      conversationId: params.conversationId,
      modelId: grant.modelId,
      purpose: "title_gen",
      inputTokens: usage?.input_tokens ?? 0,
      outputTokens: usage?.output_tokens ?? 0,
      cacheReadTokens: usage?.input_token_details?.cache_read ?? 0,
      latencyMs,
    });

    const title = cleanTitle(response.text);
    if (title.length > 0) {
      await setConversationTitle(params.userId, params.conversationId, title);
    }
  } catch {
    // Title generation is best-effort; never surface its failure.
  }
}
