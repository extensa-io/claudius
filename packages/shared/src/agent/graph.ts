import { dispatchCustomEvent } from "@langchain/core/callbacks/dispatch";
import type { BaseMessage } from "@langchain/core/messages";
import { SystemMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import {
  Annotation,
  END,
  MessagesAnnotation,
  START,
  StateGraph,
} from "@langchain/langgraph";
import { ToolNode, toolsCondition } from "@langchain/langgraph/prebuilt";
import { ObjectId } from "mongodb";
import { retrieveMemories } from "../memory/retrieve";
import { getCheckpointer } from "./checkpointer";
import { buildChatModel } from "./model";
import { attachedDocumentsNote, memoriesNote, SYSTEM_PROMPT } from "./prompts";
import { baseTools, documentTools, tools } from "./tools";

/**
 * The chat graph's state: the message channel, plus an ephemeral `memoryContext`
 * holding the memory block retrieved for the CURRENT turn. It uses a
 * replace-reducer and is overwritten every turn, so retrieved memories never
 * accumulate in the checkpointed transcript — the alternative (injecting a
 * SystemMessage into `messages`) would pile up a stale memory block per turn.
 * `load_context` fills it; the `agent` node reads it into a fresh, non-persisted
 * system prompt.
 */
const GraphAnnotation = Annotation.Root({
  ...MessagesAnnotation.spec,
  memoryContext: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => "",
  }),
});
type GraphState = typeof GraphAnnotation.State;
type GraphUpdate = typeof GraphAnnotation.Update;

/** Custom-event name carrying the memories used this turn, for the UI chip. */
export const MEMORIES_USED_EVENT = "memories_used";

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
  /**
   * Filenames of those attached documents, injected into the system prompt so
   * the model knows files are present and reliably calls retrieve_documents.
   */
  attachedDocumentNames?: string[];
  /**
   * The user's memory master switch. When false, `load_context` retrieves
   * nothing — memory is fully off for this user (Phase 3). Absent is treated as
   * enabled, matching the provisioning default.
   */
  memoryEnabled?: boolean;
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
 * `load_context`: retrieve the user's relevant long-term memories for this turn
 * and stash them in `memoryContext` for the agent node to inject. When memory is
 * off for the user, or nothing clears the similarity floor, it clears the
 * channel and injects nothing (never pad). On a hit it also dispatches a custom
 * event so the route can surface the "used N memories" chip in real time.
 *
 * Retrieval failures are swallowed to an empty context: a memory lookup must
 * never break a chat turn.
 */
async function loadContext(
  state: GraphState,
  config: RunnableConfig,
): Promise<GraphUpdate> {
  const { userId, memoryEnabled } = readConfigurable(config);
  if (!userId || memoryEnabled === false) return { memoryContext: "" };

  // The latest human message is what we retrieve against.
  const lastHuman = [...state.messages]
    .reverse()
    .find((m) => m.getType() === "human");
  const text = lastHuman?.text?.trim() ?? "";
  if (text.length === 0) return { memoryContext: "" };

  try {
    const memories = await retrieveMemories(new ObjectId(userId), text);
    if (memories.length === 0) return { memoryContext: "" };
    await dispatchCustomEvent(MEMORIES_USED_EVENT, { memories }, config);
    return { memoryContext: memoriesNote(memories) };
  } catch (err) {
    console.error(
      "Memory retrieval failed in load_context:",
      err instanceof Error ? `${err.name}: ${err.message}` : err,
    );
    return { memoryContext: "" };
  }
}

/**
 * `agent`: bind the per-run model to the tools and call it with the system
 * prompt followed by the thread so far. `config` is forwarded to `invoke` so
 * token streaming, the run tree, and the abort signal all propagate — that
 * forwarding is what lets the route observe streamed tokens via streamEvents.
 */
async function agent(
  state: GraphState,
  config: RunnableConfig,
): Promise<GraphUpdate> {
  const { inferenceProfileId, maxTokens, attachedDocumentIds, attachedDocumentNames } =
    readConfigurable(config);
  // Offer retrieve_documents only when this conversation actually has embedded
  // documents, so the model never reaches for document search on a plain chat.
  const hasDocuments =
    attachedDocumentIds !== undefined && attachedDocumentIds.length > 0;
  const boundTools = hasDocuments
    ? [...baseTools, ...documentTools]
    : baseTools;
  // Build the system prompt fresh each turn from three parts, none persisted:
  // the base identity, the memory block load_context retrieved (if any), and the
  // attached-documents note (if any). Memory comes before the docs note so the
  // model reads durable user context before task-specific material.
  const sections = [SYSTEM_PROMPT];
  if (state.memoryContext.length > 0) sections.push(state.memoryContext);
  if (hasDocuments) {
    sections.push(attachedDocumentsNote(attachedDocumentNames ?? []));
  }
  const systemPrompt = sections.join("\n\n");
  // exactOptionalPropertyTypes: only pass maxTokens when it's actually set,
  // rather than handing the builder an explicit `undefined`.
  const model = buildChatModel(
    inferenceProfileId,
    maxTokens !== undefined ? { maxTokens } : {},
  ).bindTools(boundTools);

  const response = await model.invoke(
    [new SystemMessage(systemPrompt), ...state.messages],
    config,
  );

  return { messages: [response] };
}

const builder = new StateGraph(GraphAnnotation)
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
  const values = snapshot.values as GraphState | undefined;
  return values?.messages ?? [];
}
