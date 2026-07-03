import type { WithId } from "mongodb";
import {
  appendJobProgress,
  completeJob,
  conversationsCol,
  isJobCancelled,
  loadThreadMessages,
  type MemoryExtractionJob,
  processConversationMemories,
  usersCol,
} from "@claudius/shared";
import { log } from "../log";

/**
 * Memory extraction, moved off the Vercel cron onto the worker (Phase 5, item 6).
 * The heavy lifting is unchanged: it still reads the thread from the checkpointer
 * and hands it to the SAME shared orchestrator the app used in Phase 3, so the
 * results are identical to the Phase 3 fixtures — only the trigger moved. The
 * cron now merely enqueues one of these jobs per stale conversation.
 */
export async function runMemoryExtractionJob(
  job: WithId<MemoryExtractionJob>,
): Promise<void> {
  const jobId = job._id;
  const { userId, conversationId } = job;

  if (await isJobCancelled(jobId)) return;

  const users = await usersCol();
  const user = await users.findOne({ _id: userId });
  const convs = await conversationsCol();
  const conversation = await convs.findOne({ _id: conversationId, userId });

  // A vanished/disabled user or conversation is a no-op success: nothing to do,
  // and the enqueuer already gates on these, so this is just defense in depth.
  if (!user || user.status === "disabled" || !conversation) {
    await completeJob(jobId, {
      created: 0,
      superseded: 0,
      skipped: 0,
      status: "skipped",
    });
    return;
  }

  await appendJobProgress(jobId, {
    step: "extract",
    detail: "Extracting memories from the conversation",
  });

  const messages = await loadThreadMessages(conversationId.toString());
  const summary = await processConversationMemories({
    user,
    conversation,
    messages,
  });

  await completeJob(jobId, {
    created: summary.created,
    superseded: summary.superseded,
    skipped: summary.skipped,
    status: summary.status,
  });
  log.info("memory extraction job complete", {
    jobId: jobId.toString(),
    status: summary.status,
    created: summary.created,
  });
}
