import {
  AIMessage,
  type AIMessageChunk,
  HumanMessage,
  SystemMessage,
} from "@langchain/core/messages";
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import type { ObjectId } from "mongodb";
import { after } from "next/server";
import {
  AppError,
  type Conversation,
  DICTIONARY_TTL_SECONDS,
  type DictLang,
  type Role,
  assertCanInvoke,
  buildChatModel,
  buildDictionaryMessages,
  detectLanguage,
  dictionaryCacheKey,
  getChatGraph,
  getDefaultDictionaryCacheStore,
  isAppError,
  writeUsageEvent,
} from "@claudius/shared";
import { createConversation, touchConversation } from "./conversations";
import { generateTitle } from "./titleGen";
import type { ClaudiusUIMessage } from "./types";

/**
 * Dictionary mode (Phase 10): the second "engine" behind /api/chat. A leading
 * `?` define/translate lookup resolves as a lightweight, self-contained turn —
 * no memory retrieval, no tools — whose result is cached in a global, content-
 * only store so repeats cost nothing.
 *
 * Two paths, mirroring the Phase 8 cost design:
 *   - Cache HIT: stream the stored entry, persist the turn, run NO model call,
 *     write NO usage_events row, and consume NO daily message (a free repeat).
 *   - Cache MISS: gate through assertCanInvoke (consumes a daily message and
 *     resolves the model, invariant #3), run one dictionary-prompted model call,
 *     stream it, write exactly one usage_events row (purpose `dictionary`), then
 *     cache the entry.
 *
 * The turn is persisted through the graph's message reducer (updateState), never
 * a direct checkpoint write (the checkpointer owns those collections, CLAUDE.md),
 * exactly as the redirect record is, so history survives reload.
 */

/**
 * Appended to a partial entry when the provider drops the stream mid-entry, so
 * the user understands the entry is incomplete rather than assuming the
 * dictionary had little to say. Bilingual because the entry itself is written in
 * whichever language was looked up.
 */
const TRUNCATION_NOTICE =
  "\n\n---\n\n*This entry was cut short by a provider error. Try the lookup again. / Esta entrada se interrumpió por un error del proveedor. Inténtalo de nuevo.*";

/** The subset of LangChain's usage_metadata we record. */
interface UsageMetadata {
  input_tokens?: number;
  output_tokens?: number;
  input_token_details?: { cache_read?: number };
}

/**
 * Persist a dictionary turn into the conversation's checkpoint via the graph's
 * message reducer. Both messages are tagged `claudius_dictionary` so the turn is
 * distinguishable from a normal answer (and future-stylable); it otherwise
 * renders as an ordinary Markdown assistant message.
 */
async function appendDictionaryToThread(
  threadId: string,
  userTurn: string,
  entry: string,
): Promise<void> {
  const tag = { claudius_dictionary: true };
  const graph = await getChatGraph();
  await graph.updateState(
    { configurable: { thread_id: threadId } },
    {
      messages: [
        new HumanMessage({ content: userTurn, additional_kwargs: tag }),
        new AIMessage({ content: entry, additional_kwargs: tag }),
      ],
    },
  );
}

export async function handleDictionaryTurn(params: {
  userId: ObjectId;
  role: Role;
  modelId: string;
  /** The parsed lookup (the text after `?`). */
  term: string;
  /** The original user text (`?...`), persisted as the human turn. */
  rawText: string;
  /** The owned existing conversation, or null to start a fresh one. */
  conversation: Conversation | null;
  signal: AbortSignal;
}): Promise<Response> {
  const { userId, role, modelId, term, rawText, signal } = params;

  const sourceLang: DictLang = detectLanguage(term);
  const key = dictionaryCacheKey(term, sourceLang);
  const store = getDefaultDictionaryCacheStore();
  const cached = await store.get(key);

  // A miss is a real gated turn: resolve the grant BEFORE streaming so a tripped
  // cap or a disallowed model returns a clean error (and consumes nothing extra),
  // rather than surfacing mid-stream. A hit skips the gate entirely.
  const grant = cached ? null : await assertCanInvoke(userId, modelId);

  // Only now (after the gate passes on a miss) create a conversation for a fresh
  // chat, so a tripped cap never leaves an empty row.
  const isNewConversation = params.conversation === null;
  const conversation =
    params.conversation ??
    (await createConversation({ userId, role, modelId }));
  const conversationObjId = conversation._id!;
  const threadId = conversationObjId.toString();

  // Title from the opening lookup, before the turn runs: only a new conversation
  // is ever titled, so waiting for the turn to finish means a failed first turn
  // leaves the thread on "New chat" for good.
  if (isNewConversation) {
    after(() =>
      generateTitle({
        userId,
        conversationId: conversationObjId,
        userText: rawText,
      }),
    );
  }

  const stream = createUIMessageStream<ClaudiusUIMessage>({
    onError: (error) => {
      console.error(
        "Dictionary stream error:",
        error instanceof Error ? `${error.name}: ${error.message}` : error,
      );
      return isAppError(error) ? error.message : "The lookup failed.";
    },
    execute: async ({ writer }) => {
      writer.write({ type: "start" });
      writer.write({
        type: "data-conversation",
        data: { id: threadId, title: conversation.title },
        transient: true,
      });
      writer.write({ type: "start-step" });

      const textId = "text-0";
      let entry: string;

      if (cached) {
        // Free repeat: stream the stored entry in one part, no model call.
        entry = cached.markdown;
        writer.write({ type: "text-start", id: textId });
        writer.write({ type: "text-delta", id: textId, delta: entry });
        writer.write({ type: "text-end", id: textId });
      } else {
        // Guard rather than a non-null assertion: on a miss the grant is set.
        if (!grant) throw new AppError("internal", "Missing model grant.");
        const { system, human } = buildDictionaryMessages(term, sourceLang);
        const model = buildChatModel(grant.inferenceProfileId);

        const startedAt = Date.now();
        const chunks = await model.stream(
          [new SystemMessage(system), new HumanMessage(human)],
          { signal },
        );

        let started = false;
        let gathered: AIMessageChunk | undefined;
        let assistantText = "";
        // Bedrock can drop a streaming Converse call mid-generation: the
        // InternalServerException arrives as an event inside the open stream,
        // so the SDK's pre-response retries never see it. Whatever already
        // streamed is text the user watched arrive and output we were billed
        // for, so salvage it instead of unwinding the turn.
        let streamError: unknown = null;
        try {
          for await (const chunk of chunks) {
            gathered = gathered === undefined ? chunk : gathered.concat(chunk);
            const delta = chunk.text ?? "";
            if (delta.length > 0) {
              if (!started) {
                writer.write({ type: "text-start", id: textId });
                started = true;
              }
              writer.write({ type: "text-delta", id: textId, delta });
              assistantText += delta;
            }
          }
        } catch (error) {
          streamError = error;
          const cause = (error as { cause?: unknown }).cause;
          console.error(
            "Dictionary stream truncated:",
            error instanceof Error ? `${error.name}: ${error.message}` : error,
            // The provider exception name (InternalServerException,
            // ServiceUnavailableException) usually hides in the cause, and it
            // is the part worth having in the logs.
            cause instanceof Error ? `(cause ${cause.name})` : "",
            `after ${assistantText.length} chars`,
          );
        }

        const truncated = streamError !== null;

        // Nothing usable arrived, so there is no partial turn worth keeping:
        // surface the failure to the client exactly as before.
        if (truncated && assistantText.trim().length === 0) throw streamError;

        // An abort is the user's own doing (stop button, navigation), so the
        // partial entry is kept without editorializing. A provider failure is
        // not obvious from the text alone, so say so inline.
        if (truncated && !signal.aborted) {
          const notice = TRUNCATION_NOTICE;
          writer.write({ type: "text-delta", id: textId, delta: notice });
          assistantText += notice;
        }

        if (started) writer.write({ type: "text-end", id: textId });
        const latencyMs = Date.now() - startedAt;
        entry = assistantText;

        // One usage_events row per turn (invariant #3). Usage comes off the
        // concatenated final chunk (streamUsage: true on the model). A
        // truncated stream never delivers that final chunk, so the counts fall
        // back to 0 — the row still exists so the turn is auditable, it just
        // undercounts rather than inventing an estimate.
        const usage = gathered?.usage_metadata as UsageMetadata | undefined;
        await writeUsageEvent({
          userId,
          conversationId: conversationObjId,
          modelId: grant.modelId,
          purpose: "dictionary",
          inputTokens: usage?.input_tokens ?? 0,
          outputTokens: usage?.output_tokens ?? 0,
          cacheReadTokens: usage?.input_token_details?.cache_read ?? 0,
          latencyMs,
        });

        // Cache the entry so the next lookup of this term is free. Content-only
        // and global — no userId enters the store (invariant #1). A truncated
        // entry is never cached: a 30-day TTL would otherwise serve one bad
        // stream to every future lookup of the term, for free, forever.
        if (!truncated && entry.trim().length > 0) {
          await store.set(
            key,
            { markdown: entry, sourceLang },
            DICTIONARY_TTL_SECONDS,
          );
        }
      }

      writer.write({ type: "finish-step" });
      writer.write({ type: "finish" });

      // Persist and refresh only when we produced something.
      if (entry.trim().length > 0) {
        await appendDictionaryToThread(threadId, rawText, entry);
        await touchConversation({
          userId,
          conversationId: conversationObjId,
          preview: entry,
          modelId: grant?.modelId ?? modelId,
        });
      }
    },
  });

  return createUIMessageStreamResponse({ stream });
}
