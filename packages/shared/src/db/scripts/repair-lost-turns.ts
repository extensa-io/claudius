/**
 * One-off repair for conversations damaged by the 60s function limit on
 * /api/chat (fixed by raising maxDuration and salvaging interrupted turns).
 *
 * A turn killed by the platform committed nothing: no assistant message in the
 * checkpoint, no usage row, no preview, and — when it was the first turn — no
 * title, because titling only ever runs on a new conversation. This script
 * repairs the two consequences that outlived the code fix:
 *
 *   `titles`  Backfill a title for every conversation still on "New chat", from
 *             the first human turn in its thread.
 *   `thread`  Rebuild one specific thread whose first answer was lost: reset it
 *             to the opening question and re-run the graph so a real assistant
 *             message is generated and stored by the checkpointer.
 *
 * Both paths go through assertCanInvoke and write usage_events (invariant #3).
 * Usage: tsx repair-lost-turns.ts titles [--apply]
 *        tsx repair-lost-turns.ts thread <conversationId> [--apply]
 *
 * Without --apply the script only reports what it would do.
 */
import { writeFileSync } from "node:fs";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { ObjectId } from "mongodb";
import { getChatGraph, loadThreadMessages } from "../../agent/graph";
import { buildChatModel } from "../../agent/model";
import { assertCanInvoke } from "../../tiers/assertCanInvoke";
import { writeUsageEvent } from "../../usage/writeUsageEvent";
import { conversationsCol } from "../collections";
import { getDb } from "../client";

const TITLE_MODEL_ID = "haiku";
const REPAIR_MODEL_ID = "sonnet";
const DEFAULT_TITLE = "New chat";

const TITLE_SYSTEM = `You write short conversation titles. Given the opening of a
conversation, reply with a 3 to 6 word title in Title Case, in the same language
as the user. No quotes, no trailing punctuation, no preamble — just the title.`;

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

/** Title one conversation from a user message. Mirrors app/lib/chat/titleGen. */
async function titleFrom(
  userId: ObjectId,
  conversationId: ObjectId,
  userText: string,
): Promise<string> {
  const grant = await assertCanInvoke(userId, TITLE_MODEL_ID, {
    consumeDailyMessage: false,
  });
  const model = buildChatModel(grant.inferenceProfileId, {
    maxTokens: 24,
    temperature: 0.3,
  });
  const startedAt = Date.now();
  const response = await model.invoke([
    new SystemMessage(TITLE_SYSTEM),
    new HumanMessage(`User: ${userText}`),
  ]);
  const usage = response.usage_metadata as UsageMetadata | undefined;
  await writeUsageEvent({
    userId,
    conversationId,
    modelId: grant.modelId,
    purpose: "title_gen",
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    cacheReadTokens: usage?.input_token_details?.cache_read ?? 0,
    latencyMs: Date.now() - startedAt,
  });
  return cleanTitle(response.text);
}

async function backfillTitles(apply: boolean): Promise<void> {
  const col = await conversationsCol();
  const untitled = await col.find({ title: DEFAULT_TITLE }).toArray();
  console.log(`Found ${untitled.length} conversation(s) still on "${DEFAULT_TITLE}".`);

  for (const conv of untitled) {
    const id = conv._id!;
    const messages = await loadThreadMessages(id.toString());
    const firstHuman = messages.find((m) => m.getType() === "human");
    const seed = firstHuman?.text.trim() ?? "";
    if (seed.length === 0) {
      console.log(`  ${id.toString()}: no human turn in the thread, skipping.`);
      continue;
    }
    if (!apply) {
      console.log(`  ${id.toString()}: would title from "${seed.slice(0, 60)}…"`);
      continue;
    }
    const title = await titleFrom(conv.userId, id, seed);
    if (title.length === 0) {
      console.log(`  ${id.toString()}: model returned an empty title, skipping.`);
      continue;
    }
    await col.updateOne({ _id: id, userId: conv.userId }, { $set: { title } });
    console.log(`  ${id.toString()}: "${title}"`);
  }
}

/**
 * Rebuild a thread whose first answer was lost. The stored state is the opening
 * question plus any follow-ups the user typed while confused by the missing
 * reply; none of it has assistant content, so we reset the thread and re-run the
 * graph on the original question. The checkpointer normally owns `checkpoints`
 * and `checkpoint_writes` exclusively — this deletion is a deliberate one-off
 * repair of a corrupt thread, dumped to disk first, not something app code does.
 */
async function rebuildThread(conversationId: string, apply: boolean): Promise<void> {
  const col = await conversationsCol();
  const id = new ObjectId(conversationId);
  const conv = await col.findOne({ _id: id });
  if (!conv) throw new Error(`Conversation ${conversationId} not found.`);

  const messages = await loadThreadMessages(conversationId);
  const firstHuman = messages.find((m) => m.getType() === "human");
  const question = firstHuman?.text.trim() ?? "";
  const assistantTurns = messages.filter(
    (m) => m.getType() === "ai" && m.text.trim().length > 0,
  );
  console.log(
    `Thread ${conversationId}: ${messages.length} message(s), ${assistantTurns.length} with assistant text.`,
  );
  if (question.length === 0) throw new Error("No human turn to rebuild from.");
  if (assistantTurns.length > 0) {
    throw new Error(
      "Thread already has assistant text; refusing to rebuild it. Repair by hand.",
    );
  }
  const dropped = messages.filter((m) => m !== firstHuman).length;
  console.log(`  keeping: "${question.slice(0, 80)}…"`);
  console.log(`  dropping ${dropped} orphan message(s) with no answer`);
  if (!apply) {
    console.log("  (dry run — pass --apply to rebuild)");
    return;
  }

  // 1. Back the raw thread up before touching it.
  const db = await getDb();
  const backup = {
    checkpoints: await db
      .collection("checkpoints")
      .find({ thread_id: conversationId })
      .toArray(),
    checkpoint_writes: await db
      .collection("checkpoint_writes")
      .find({ thread_id: conversationId })
      .toArray(),
  };
  const path = `./thread-backup-${conversationId}.json`;
  writeFileSync(path, JSON.stringify(backup, null, 2));
  console.log(
    `  backed up ${backup.checkpoints.length} checkpoint(s) and ${backup.checkpoint_writes.length} write(s) to ${path}`,
  );

  // 2. Reset the thread.
  await db.collection("checkpoints").deleteMany({ thread_id: conversationId });
  await db
    .collection("checkpoint_writes")
    .deleteMany({ thread_id: conversationId });
  console.log("  thread reset");

  // 3. Re-run the graph on the original question. This is a normal gated model
  //    call and the checkpointer commits the answer exactly as a live turn would.
  const grant = await assertCanInvoke(conv.userId, REPAIR_MODEL_ID, {
    consumeDailyMessage: false,
  });
  const graph = await getChatGraph();
  const startedAt = Date.now();
  const result = await graph.invoke(
    { messages: [new HumanMessage(question)] },
    {
      configurable: {
        thread_id: conversationId,
        inferenceProfileId: grant.inferenceProfileId,
        userId: conv.userId.toString(),
        memoryEnabled: grant.memoryEnabled,
        canReadUrls: true,
      },
      recursionLimit: 25,
    },
  );
  const latencyMs = Date.now() - startedAt;

  const finalMessages = result.messages;
  const answer = finalMessages[finalMessages.length - 1];
  const answerText = answer?.text.trim() ?? "";
  if (answerText.length === 0) throw new Error("Re-run produced no answer text.");
  const usage = (answer as { usage_metadata?: UsageMetadata }).usage_metadata;
  await writeUsageEvent({
    userId: conv.userId,
    conversationId: id,
    modelId: grant.modelId,
    purpose: "chat",
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    cacheReadTokens: usage?.input_token_details?.cache_read ?? 0,
    latencyMs,
  });
  console.log(
    `  answered in ${(latencyMs / 1000).toFixed(1)}s, ${answerText.length} chars`,
  );

  // 4. Refresh the conversation row: preview, model, and a title if it needs one.
  const title =
    conv.title === DEFAULT_TITLE
      ? await titleFrom(conv.userId, id, question)
      : conv.title;
  await col.updateOne(
    { _id: id, userId: conv.userId },
    {
      $set: {
        title,
        updatedAt: new Date(),
        lastMessagePreview: answerText.slice(0, 140),
        modelId: grant.modelId,
      },
    },
  );
  console.log(`  title: "${title}"`);
}

async function main(): Promise<void> {
  const [mode, ...rest] = process.argv.slice(2);
  const apply = process.argv.includes("--apply");

  if (mode === "titles") {
    await backfillTitles(apply);
  } else if (mode === "thread") {
    const target = rest.find((a) => !a.startsWith("--"));
    if (!target) throw new Error("Usage: repair-lost-turns.ts thread <conversationId>");
    await rebuildThread(target, apply);
  } else {
    throw new Error("Usage: repair-lost-turns.ts <titles|thread> [args] [--apply]");
  }
  process.exit(0);
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
