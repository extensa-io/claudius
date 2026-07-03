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
 *
 * Both messages are tagged `additional_kwargs.claudius_research` (and the job id)
 * so the UI can render the report as a report — with its download and refine
 * controls — when rebuilding the transcript on reload, and so a refine can point
 * back at the job it builds on. The `userTurn` is the original question for a
 * fresh report, or the refinement instruction for a refine.
 */
export async function appendResearchToThread(
  threadId: string,
  userTurn: string,
  report: string,
  jobId: string,
): Promise<void> {
  const tag = { claudius_research: true, claudius_job_id: jobId };
  const graph = await getChatGraph();
  await graph.updateState(
    { configurable: { thread_id: threadId } },
    {
      messages: [
        new HumanMessage({ content: userTurn, additional_kwargs: tag }),
        new AIMessage({ content: report, additional_kwargs: tag }),
      ],
    },
  );
}
