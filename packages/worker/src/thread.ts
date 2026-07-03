import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { getChatGraph } from "@claudius/shared";

/**
 * Write a completed research exchange into the conversation's checkpoint so it
 * lives in chat history. This is what makes "resuming the conversation later
 * includes the report in context" true (an acceptance criterion): the report is
 * not a side record on the job, it becomes real thread state.
 *
 * We reuse the chat graph's checkpointer via `updateState` rather than writing to
 * the checkpoint collections directly (the checkpointer owns those — CLAUDE.md).
 * `updateState` runs the graph's message reducer, so the question and report are
 * appended to the existing thread exactly as a normal turn would be, keyed by the
 * conversation id. Written as one update so a thread never shows a question
 * without its report.
 */
export async function appendResearchToThread(
  threadId: string,
  question: string,
  report: string,
): Promise<void> {
  const graph = await getChatGraph();
  await graph.updateState(
    { configurable: { thread_id: threadId } },
    {
      messages: [
        new HumanMessage(question),
        new AIMessage(report),
      ],
    },
  );
}
