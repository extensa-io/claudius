import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { getChatGraph } from "@claudius/shared";

/**
 * Persist a zero-cost redirect into the conversation's checkpoint (Phase 8), so
 * history is honest about where a bang or navigational query sent the user. This
 * runs on the pre-graph interceptor path — NO model call, NO usage_events — but
 * the record still becomes real thread state, so it survives reload.
 *
 * We reuse the chat graph's `updateState` (its message reducer), never a direct
 * checkpoint write, because the checkpointer owns those collections (CLAUDE.md).
 * The exchange is tagged `additional_kwargs.claudius_redirect` so the transcript
 * renderer can style it as a small "sent you to …" note rather than a normal
 * assistant answer, and so it is distinguishable from a research report.
 *
 * Only called when the conversation already exists — a bang typed as the first
 * message of a fresh chat deliberately creates no conversation, so there is no
 * thread to append to (the client shows an ephemeral note instead).
 */
export async function appendRedirectToThread(
  threadId: string,
  userTurn: string,
  url: string,
  label: string,
): Promise<void> {
  const tag = { claudius_redirect: true, claudius_redirect_url: url };
  const graph = await getChatGraph();
  await graph.updateState(
    { configurable: { thread_id: threadId } },
    {
      messages: [
        new HumanMessage({ content: userTurn, additional_kwargs: tag }),
        new AIMessage({
          content: `Opened ${url} (${label}).`,
          additional_kwargs: tag,
        }),
      ],
    },
  );
}
