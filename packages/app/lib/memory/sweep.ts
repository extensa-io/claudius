import { ObjectId } from "mongodb";
import {
  type Conversation,
  type ExtractionSummary,
  type User,
  conversationsCol,
  loadThreadMessages,
  processConversationMemories,
  usersCol,
} from "@claudius/shared";

/**
 * The app-side glue for memory extraction: it reads each conversation's
 * transcript from the checkpointer and hands it to the shared orchestrator,
 * which owns the extraction/dedup/caps logic. Both triggers use these — the
 * Vercel cron (`sweepAllStale`) and the sign-in lazy pass (`sweepUserMemories`).
 * Keeping the checkpointer read here means the shared orchestrator stays free of
 * any graph dependency, which is what lets the Phase 4 worker reuse it.
 */

/**
 * A conversation needs extraction when it has never been processed or has been
 * touched since it last was. `updatedAt` is bumped on every turn; `lastRunAt` is
 * set when extraction runs, so `updatedAt > lastRunAt` means "new turns since".
 */
function staleFilter(): Record<string, unknown> {
  return {
    $or: [
      { extraction: { $exists: false } },
      { $expr: { $gt: ["$updatedAt", "$extraction.lastRunAt"] } },
    ],
  };
}

/** Extract memories for one conversation. Never throws; logs and reports zeros. */
async function sweepConversation(
  user: User,
  conversation: Conversation,
): Promise<ExtractionSummary> {
  try {
    const messages = await loadThreadMessages(conversation._id!.toString());
    return await processConversationMemories({ user, conversation, messages });
  } catch (err) {
    console.error(
      `Memory sweep failed for conversation ${conversation._id?.toString()}:`,
      err instanceof Error ? `${err.name}: ${err.message}` : err,
    );
    return { status: "up_to_date", created: 0, superseded: 0, skipped: 0, outcomes: [] };
  }
}

export interface SweepResult {
  conversationsProcessed: number;
  created: number;
  superseded: number;
  skipped: number;
}

function tally(summaries: ExtractionSummary[]): SweepResult {
  return {
    conversationsProcessed: summaries.length,
    created: summaries.reduce((n, s) => n + s.created, 0),
    superseded: summaries.reduce((n, s) => n + s.superseded, 0),
    skipped: summaries.reduce((n, s) => n + s.skipped, 0),
  };
}

/**
 * Lazy, best-effort sweep of one user's stale conversations. Called on sign-in
 * (via `after()`), so it's bounded small to stay within the serverless budget;
 * the daily cron catches anything left over.
 */
export async function sweepUserMemories(
  userId: ObjectId,
  limit = 5,
): Promise<SweepResult> {
  const users = await usersCol();
  const user = await users.findOne({ _id: userId });
  if (!user || user.status === "disabled" || user.memoryEnabled === false) {
    return { conversationsProcessed: 0, created: 0, superseded: 0, skipped: 0 };
  }

  const convCol = await conversationsCol();
  const stale = await convCol
    .find({ userId, ...staleFilter() })
    .sort({ updatedAt: -1 })
    .limit(limit)
    .toArray();

  const summaries: ExtractionSummary[] = [];
  for (const conversation of stale) {
    summaries.push(await sweepConversation(user, conversation));
  }
  return tally(summaries);
}

/**
 * The cron batch: process a bounded set of stale conversations across all users.
 * Bounded because Vercel Hobby caps a function at 60s; whatever doesn't fit is
 * picked up on the next daily run. Users are loaded once and cached, and
 * memory-off / disabled users are skipped without reading their transcripts.
 */
export async function sweepAllStale(limit = 15): Promise<SweepResult> {
  const convCol = await conversationsCol();
  const stale = await convCol
    .find(staleFilter())
    .sort({ updatedAt: -1 })
    .limit(limit)
    .toArray();

  const users = await usersCol();
  const userCache = new Map<string, User | null>();
  const summaries: ExtractionSummary[] = [];

  for (const conversation of stale) {
    const key = conversation.userId.toString();
    let user = userCache.get(key);
    if (user === undefined) {
      user = await users.findOne({ _id: conversation.userId });
      userCache.set(key, user);
    }
    if (!user || user.status === "disabled" || user.memoryEnabled === false) {
      continue;
    }
    summaries.push(await sweepConversation(user, conversation));
  }
  return tally(summaries);
}
