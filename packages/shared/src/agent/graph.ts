import type { BaseMessage } from "@langchain/core/messages";
import { SystemMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import {
  END,
  MessagesAnnotation,
  START,
  StateGraph,
} from "@langchain/langgraph";
import { ToolNode, toolsCondition } from "@langchain/langgraph/prebuilt";
import { getCheckpointer } from "./checkpointer";
import { buildChatModel } from "./model";
import { SYSTEM_PROMPT } from "./prompts";
import { baseTools, documentTools, tools } from "./tools";

/**
 * Per-invocation graph configuration, passed through `configurable`. The model
 * is chosen *per run*, not baked into the compiled graph, so a conversation can
 * switch models mid-thread (spec) without rebuilding or re-checkpointing: the
 * same thread keeps its message history while each turn picks up the model the
 * caller passed.
 */
export interface ChatGraphConfigurable {
  /** thread_id is the conversation `_id` string; keys the checkpointer. */
  thread_id: string;
  /** Bedrock inference profile resolved by assertCanInvoke. */
  inferenceProfileId: string;
  maxTokens?: number;
  /** Owner id; required by retrieve_documents to pre-filter its vector search. */
  userId?: string;
  /**
   * The conversation's attached, embedded document ids. When non-empty the agent
   * is offered the retrieve_documents tool and the tool scopes its search to
   * exactly these documents; empty (or absent) means no document RAG this turn.
   */
  attachedDocumentIds?: string[];
}

function readConfigurable(config: RunnableConfig): ChatGraphConfigurable {
  const configurable = config.configurable as
    | Partial<ChatGraphConfigurable>
    | undefined;
  if (!configurable?.inferenceProfileId) {
    throw new Error("Graph invoked without an inferenceProfileId in config.");
  }
  return configurable as ChatGraphConfigurable;
}

/**
 * `load_context`: a pass-through this phase. Phase 3 wires memory retrieval in
 * here — it will load the user's relevant memories and prepend them as context
 * ahead of the system prompt. For now it makes no state change, but it keeps the
 * graph topology stable so adding memory later is a node change, not a rewire.
 */
async function loadContext(): Promise<typeof MessagesAnnotation.Update> {
  return {};
}

/**
 * `agent`: bind the per-run model to the tools and call it with the system
 * prompt followed by the thread so far. `config` is forwarded to `invoke` so
 * token streaming, the run tree, and the abort signal all propagate — that
 * forwarding is what lets the route observe streamed tokens via streamEvents.
 */
async function agent(
  state: typeof MessagesAnnotation.State,
  config: RunnableConfig,
): Promise<typeof MessagesAnnotation.Update> {
  const { inferenceProfileId, maxTokens, attachedDocumentIds } =
    readConfigurable(config);
  // Offer retrieve_documents only when this conversation actually has embedded
  // documents, so the model never reaches for document search on a plain chat.
  const boundTools =
    attachedDocumentIds && attachedDocumentIds.length > 0
      ? [...baseTools, ...documentTools]
      : baseTools;
  // exactOptionalPropertyTypes: only pass maxTokens when it's actually set,
  // rather than handing the builder an explicit `undefined`.
  const model = buildChatModel(
    inferenceProfileId,
    maxTokens !== undefined ? { maxTokens } : {},
  ).bindTools(boundTools);

  const response = await model.invoke(
    [new SystemMessage(SYSTEM_PROMPT), ...state.messages],
    config,
  );

  return { messages: [response] };
}

const builder = new StateGraph(MessagesAnnotation)
  .addNode("load_context", loadContext)
  .addNode("agent", agent)
  .addNode("tools", new ToolNode(tools))
  .addEdge(START, "load_context")
  .addEdge("load_context", "agent")
  // The agent loops to the tools node whenever it emits tool calls, and ends
  // the run when it returns a plain message. toolsCondition is the prebuilt
  // router that reads the last message and picks "tools" or END.
  .addConditionalEdges("agent", toolsCondition, ["tools", END])
  .addEdge("tools", "agent");

const globalForGraph = globalThis as unknown as {
  _claudiusChatGraph?: Promise<ReturnType<typeof compileGraph>>;
};

function compileGraph(checkpointer: Awaited<ReturnType<typeof getCheckpointer>>) {
  return builder.compile({ checkpointer });
}

async function createGraph(): Promise<ReturnType<typeof compileGraph>> {
  const checkpointer = await getCheckpointer();
  return compileGraph(checkpointer);
}

/** The compiled, checkpointed chat graph (cached per process). */
export function getChatGraph(): Promise<ReturnType<typeof compileGraph>> {
  return (globalForGraph._claudiusChatGraph ??= createGraph());
}

/**
 * Read a thread's full message history straight from the checkpointer. This is
 * how a conversation resumes: opening it loads the persisted graph state for
 * `thread_id` (the conversation id) rather than re-sending history from the
 * client. A thread with no checkpoint yet returns an empty array.
 */
export async function loadThreadMessages(
  threadId: string,
): Promise<BaseMessage[]> {
  const graph = await getChatGraph();
  const snapshot = await graph.getState({
    configurable: { thread_id: threadId },
  });
  const values = snapshot.values as
    | typeof MessagesAnnotation.State
    | undefined;
  return values?.messages ?? [];
}
