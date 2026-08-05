import { AIMessage } from "@langchain/core/messages";
import { getChatGraph } from "@claudius/shared";

/**
 * Persist the text of a turn that never finished, so an interrupted run leaves
 * honest history instead of a hole.
 *
 * Why this exists: the graph only commits the assistant message when the agent
 * node *returns*. If the run is aborted — the client disconnects, the model call
 * fails after streaming, the platform kills a long request — the user has watched
 * a reply appear on screen while the checkpoint keeps only their question. On
 * reload the thread reads as an unanswered turn, and the model, seeing no answer
 * of its own, answers again from scratch on the next turn.
 *
 * We append through the graph's message reducer (`updateState`), never a direct
 * checkpoint write, for the same reason the redirect and dictionary records do:
 * the checkpointer owns those collections. The message is tagged
 * `claudius_partial` so the transcript can mark it as cut short.
 */
export async function appendPartialAssistantTurn(
  threadId: string,
  assistantText: string,
): Promise<void> {
  if (assistantText.trim().length === 0) return;
  const graph = await getChatGraph();
  await graph.updateState(
    { configurable: { thread_id: threadId } },
    {
      messages: [
        new AIMessage({
          content: assistantText,
          additional_kwargs: { claudius_partial: true },
        }),
      ],
    },
  );
}
