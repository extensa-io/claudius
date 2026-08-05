import { dispatchCustomEvent } from "@langchain/core/callbacks/dispatch";
import type { BaseMessage } from "@langchain/core/messages";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
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
import { hydrateTurnImages, resolveTurnImages } from "../documents/images";
import { getProfileMemories, retrieveMemories } from "../memory/retrieve";
import type { RetrievedMemory } from "../memory/types";
import { getCheckpointer } from "./checkpointer";
import { buildChatModel } from "./model";
import {
  attachedDocumentsNote,
  currentDateLine,
  memoriesNote,
  SYSTEM_PROMPT,
  userSettingsNote,
} from "./prompts";
import { selectBoundTools, tools } from "./tools";

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
  /**
   * The user's authored settings: a preferred name and a freeform instructions
   * block. Injected verbatim into the system prompt above the inferred memory
   * block, and outranking it (see userSettingsNote). Members and admins only —
   * the route leaves these absent for guests, so the section is simply omitted.
   */
  preferredName?: string | null;
  customInstructions?: string | null;
  /**
   * Whether this turn may use the read_url tool (Phase 11). The route sets it
   * true for members and admins and leaves it absent for guests, so URL fetching
   * is bound only for authorized roles — the same session-derived gating as the
   * member-only settings above (invariant #2). No client input decides this.
   */
  canReadUrls?: boolean;
  /**
   * Image ids attached to THIS turn (Phase 12), resolved and ownership-checked
   * by the route.
   *
   * They travel in `configurable` — which is per-run and NOT checkpointed — for
   * a specific reason. `messages` is part of the state MongoDBSaver persists, and
   * it writes a checkpoint per graph step, each carrying the full channel. A
   * base64 image placed in a message is therefore rewritten on every step of
   * every later turn for the life of the thread: a 4MB photo does not cost 4MB
   * once, it costs 4MB times however many checkpoints the thread accumulates,
   * heading for the 16MB BSON ceiling with nothing in the checkpointer to stop
   * it. It would also be replayed into every subsequent model call, silently
   * re-billed as input tokens with no UI saying the image is still attached.
   *
   * Keeping the ids here and hydrating the bytes at invoke time avoids both. It
   * is the same trick the system prompt and `memoryContext` already use: rebuilt
   * per run, never persisted. The one-turn lifetime then needs no eviction
   * policy — the next turn simply carries no ids, so nothing is hydrated.
   */
  imageIds?: string[];
  /**
   * Whether this turn may send images at all: the role's tier permits it AND the
   * resolved model supports vision. Set from the server-side grant, never from
   * client input (invariant #2), exactly like canReadUrls.
   */
  canUseVision?: boolean;
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

/** How many recent human turns feed the retrieval query (Phase 6). */
const QUERY_WINDOW_HUMAN_TURNS = 3;
/** Cap the constructed query so a long paste doesn't dominate the embedding. */
const QUERY_MAX_CHARS = 1000;

/**
 * Build the retrieval query from the last few human turns, not just the final
 * utterance (Phase 6, scope item 3). A thin or contentless message ("who am I?",
 * "and after that?") embeds nowhere near a stored declarative fact on its own;
 * folding in the recent turn context gives follow-ups and pronoun references
 * something to match. Chronological order, current message last, bounded length.
 */
function buildRetrievalQuery(state: GraphState): string {
  const humanTexts = state.messages
    .filter((m) => m.getType() === "human")
    .map((m) => m.text.trim())
    .filter((t) => t.length > 0);
  const recent = humanTexts.slice(-QUERY_WINDOW_HUMAN_TURNS);
  return recent.join("\n").slice(-QUERY_MAX_CHARS).trim();
}

/**
 * `load_context`: assemble the two memory paths for this turn and stash the
 * combined block in `memoryContext` for the agent node to inject.
 *
 *   1. The always-on profile — the user's defining identity memories, injected
 *      every turn regardless of vector score, so identity is present even on a
 *      turn that resembles no stored fact.
 *   2. Salience-weighted retrieval — the task-relevant vector match for the
 *      constructed query, with the profile's rows excluded so nothing repeats.
 *
 * When memory is off for the user, or neither path returns anything, it clears
 * the channel and injects nothing (never pad). On any memory it dispatches a
 * custom event tagging each as profile vs retrieved, so the route can surface
 * the "used N memories" chip (split by source) in real time.
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

  const ownerId = new ObjectId(userId);
  const query = buildRetrievalQuery(state);

  try {
    // Profile first: it's cheap (no vector search) and its ids exclude the
    // retrieval path from re-injecting the same fact.
    const profile = await getProfileMemories(ownerId);
    const profileIds = profile.map((m) => m.id);
    const retrieved =
      query.length > 0
        ? await retrieveMemories(ownerId, query, profileIds)
        : [];

    const all: RetrievedMemory[] = [...profile, ...retrieved];
    if (all.length === 0) return { memoryContext: "" };

    await dispatchCustomEvent(MEMORIES_USED_EVENT, { memories: all }, config);
    return { memoryContext: memoriesNote({ profile, retrieved }) };
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
  const {
    inferenceProfileId,
    maxTokens,
    attachedDocumentIds,
    attachedDocumentNames,
    preferredName,
    customInstructions,
    canReadUrls,
    imageIds,
    canUseVision,
    userId,
  } = readConfigurable(config);
  // Offer retrieve_documents only when this conversation actually has embedded
  // documents, so the model never reaches for document search on a plain chat;
  // offer read_url only when the role allows it (members/admins, never guests).
  const hasDocuments =
    attachedDocumentIds !== undefined && attachedDocumentIds.length > 0;
  const boundTools = selectBoundTools({
    hasDocuments,
    canReadUrls: canReadUrls ?? false,
  });
  // Build the system prompt fresh each turn from parts, none persisted: the
  // current date (so the model is grounded in the present, not its training
  // cutoff), the base identity, the user's authored settings (if any), the
  // memory block load_context retrieved (if any), and the attached-documents
  // note (if any). The date leads so the prompt's "the current date and time
  // above" reference resolves. The authored settings sit ABOVE memory and
  // outrank it: what the user explicitly told us wins over what we inferred.
  const sections = [currentDateLine(new Date()), SYSTEM_PROMPT];
  const settingsNote = userSettingsNote({
    preferredName: preferredName ?? null,
    instructions: customInstructions ?? null,
  });
  if (settingsNote) sections.push(settingsNote);
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

  // Ephemeral image hydration (Phase 12). `messages` below is a LOCAL array; the
  // multimodal turn it may contain is handed to the model and then dropped on the
  // floor. Only `response` is returned as an update, so nothing image-bearing
  // ever reaches the checkpointer. See ChatGraphConfigurable.imageIds for why
  // that matters.
  const messages = await withHydratedImages(state.messages, {
    imageIds: canUseVision ? (imageIds ?? []) : [],
    userId,
  });

  const response = await model.invoke(
    [new SystemMessage(systemPrompt), ...messages],
    config,
  );

  return { messages: [response] };
}

/**
 * Return a copy of the thread in which the FINAL human turn carries this run's
 * images as content blocks. Everything else is passed through untouched, and the
 * input array is never mutated — the caller's `state.messages` must stay exactly
 * as the checkpointer will persist it.
 *
 * Images ride on the last human turn rather than a message of their own because
 * that is the turn they were attached to: the user's question and the picture
 * they asked it about belong in the same block, which is also the arrangement the
 * model reads most naturally.
 */
export async function withHydratedImages(
  messages: BaseMessage[],
  { imageIds, userId }: { imageIds: string[]; userId: string | undefined },
): Promise<BaseMessage[]> {
  if (imageIds.length === 0 || !userId) return messages;

  // findLast* needs a newer lib target than this package builds against; a
  // reverse scan is equivalent and keeps the tsconfig alone.
  let lastHumanIndex = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]!.getType() === "human") {
      lastHumanIndex = i;
      break;
    }
  }
  if (lastHumanIndex === -1) return messages;

  const resolved = await resolveTurnImages(new ObjectId(userId), imageIds);
  const hydrated = await hydrateTurnImages(resolved);
  if (hydrated.length === 0) return messages;

  const original = messages[lastHumanIndex]!;
  const text = original.text;
  const multimodal = new HumanMessage({
    content: [
      ...hydrated.map((image) => ({
        type: "image" as const,
        source: {
          type: "base64" as const,
          media_type: image.mimeType,
          data: image.base64,
        },
      })),
      // Text last: with the images already in view, the question reads as being
      // about them. An image-only turn contributes no text block at all rather
      // than an empty string, which Bedrock rejects.
      ...(text.trim().length > 0 ? [{ type: "text" as const, text }] : []),
    ],
  });

  const copy = [...messages];
  copy[lastHumanIndex] = multimodal;
  return copy;
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
