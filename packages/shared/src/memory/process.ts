import type { BaseMessage } from "@langchain/core/messages";
import { conversationsCol } from "../db/collections";
import type { Conversation, User } from "../db/schemas";
import { loadTier } from "../tiers";
import { extractCandidates } from "./extract";
import { persistCandidate } from "./persist";
import type { ExtractionSummary, PersistOutcome } from "./types";

/**
 * The extraction orchestrator, reused by both triggers (the Vercel cron and the
 * sign-in sweep) and, from Phase 4, the Railway worker. It takes the messages in
 * rather than reading the checkpointer itself, so it stays free of any graph or
 * Next.js dependency — the caller loads the transcript and hands it over.
 *
 * It is a strict no-op when memory is off for the user (invariant of the
 * feature: a disabled user gets zero extraction calls) and idempotent-ish via a
 * per-conversation watermark: only the turns beyond `extraction.messageCount`
 * are ever sent to the model, so re-running after new turns extracts just the
 * delta instead of re-reading the whole thread.
 */

const EMPTY: Omit<ExtractionSummary, "status"> = {
  created: 0,
  superseded: 0,
  skipped: 0,
  outcomes: [],
};

/** Render only the human/assistant text turns of the delta as a transcript. */
function formatTranscript(delta: BaseMessage[]): string {
  const lines: string[] = [];
  for (const message of delta) {
    const type = message.getType();
    const text = message.text.trim();
    if (text.length === 0) continue;
    if (type === "human") lines.push(`User: ${text}`);
    else if (type === "ai") lines.push(`Assistant: ${text}`);
  }
  return lines.join("\n\n");
}

function hasUserTurn(delta: BaseMessage[]): boolean {
  return delta.some(
    (m) => m.getType() === "human" && m.text.trim().length > 0,
  );
}

async function advanceWatermark(
  conversation: Conversation,
  messageCount: number,
): Promise<void> {
  const col = await conversationsCol();
  await col.updateOne(
    { _id: conversation._id!, userId: conversation.userId },
    { $set: { extraction: { lastRunAt: new Date(), messageCount } } },
  );
}

export async function processConversationMemories(params: {
  user: User;
  conversation: Conversation;
  messages: BaseMessage[];
}): Promise<ExtractionSummary> {
  const { user, conversation, messages } = params;
  const userId = user._id!;

  // Feature master switch: no extraction at all when the user turned memory off.
  // Do NOT advance the watermark, so re-enabling reprocesses the missed turns.
  if (user.memoryEnabled === false) {
    return { status: "disabled", ...EMPTY };
  }

  // An incognito thread is never mined. The enqueuer already filters these out,
  // but the worker is a separate process claiming jobs from Mongo and must not
  // depend on the enqueuer having been right — a job inserted before the flag
  // existed, or by a future caller, still stops here. The watermark is left
  // alone: there is nothing to reprocess, since the flag never changes.
  if (conversation.incognito) {
    return { status: "disabled", ...EMPTY };
  }

  const tier = await loadTier(user.role);
  if (tier.memoryCap <= 0) {
    return { status: "no_allowance", ...EMPTY };
  }

  const prevCount = conversation.extraction?.messageCount ?? 0;
  if (messages.length <= prevCount) {
    return { status: "up_to_date", ...EMPTY };
  }

  const delta = messages.slice(prevCount);
  if (!hasUserTurn(delta)) {
    // Nothing a user said to learn from; still move the watermark so we don't
    // re-scan these same turns on every sweep.
    await advanceWatermark(conversation, messages.length);
    return { status: "no_content", ...EMPTY };
  }

  const transcript = formatTranscript(delta);
  const candidates = await extractCandidates({
    userId,
    conversationId: conversation._id!,
    transcript,
  });

  const outcomes: PersistOutcome[] = [];
  for (const candidate of candidates) {
    // Persist one at a time: each insert can shift the dedup/cap state the next
    // candidate sees, so they must not race.
    outcomes.push(
      await persistCandidate({
        userId,
        role: user.role,
        memoryCap: tier.memoryCap,
        candidate,
        sourceConversationId: conversation._id!,
      }),
    );
  }

  await advanceWatermark(conversation, messages.length);

  return {
    status: "ok",
    created: outcomes.filter((o) => o.action === "created").length,
    superseded: outcomes.filter((o) => o.action === "superseded").length,
    skipped: outcomes.filter((o) => o.action === "skipped").length,
    outcomes,
  };
}
