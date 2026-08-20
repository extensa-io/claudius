import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import type { ObjectId } from "mongodb";
import { after } from "next/server";
import {
  type ChangeWindow,
  type Conversation,
  type ConvertQuery,
  type MarketFailureReason,
  type QuoteQuery,
  type QuoteValue,
  type Role,
  type SymbolQuery,
  conversionCacheKey,
  fetchExchangeRate,
  fetchQuote,
  getChatGraph,
  getDefaultQuoteCacheStore,
  isAppError,
  quoteCacheKey,
  quoteTtlSeconds,
  renderConversion,
  renderQuote,
  resolveChange,
  resolveSymbol,
} from "@claudius/shared";
import { createConversation, touchConversation } from "./conversations";
import { generateTitle } from "./titleGen";
import type { ClaudiusUIMessage } from "./types";

/**
 * Quote mode (Phase 13): the third "engine" behind /api/chat. A leading `$`
 * resolves an instrument quote or a currency conversion and streams a rendered
 * markdown block.
 *
 * What makes this path different from the dictionary path it otherwise mirrors:
 * the answer is DATA, so there is NO model call on any branch. No
 * `assertCanInvoke`, no `usage_events` row, no daily message consumed. Invariant
 * #3 ("every Bedrock invocation is gated and logged") holds trivially because
 * there is no Bedrock invocation to gate. The metered resource is the provider
 * call, and the session-aware cache is what protects it.
 *
 * The turn is persisted through the graph's message reducer (updateState), never
 * a direct checkpoint write (the checkpointer owns those collections), exactly as
 * the redirect and dictionary records are, so history survives reload.
 */

/**
 * User-safe copy per failure reason. Each one is deliberately explicit about
 * WHY, and none of them invents a number — a quote that couldn't be fetched has
 * to read as a miss, not as a price.
 */
const FAILURE_MESSAGE: Record<MarketFailureReason, string> = {
  not_configured:
    "Quotes are unavailable right now — this deployment has no market-data provider configured.",
  unknown_symbol:
    "I couldn't find that symbol. Try the exact ticker (for example `$MDB`), or a currency pair like `$500 CAD to COP`.",
  rate_limited:
    "The market-data provider's rate limit is exhausted for now. Try again in a minute.",
  provider_error:
    "The market-data provider didn't respond. Try again in a moment.",
};

/**
 * Persist a quote turn into the conversation's checkpoint via the graph's message
 * reducer. Both messages are tagged `claudius_quote` so the turn is
 * distinguishable from a normal answer; it otherwise renders as an ordinary
 * Markdown assistant message.
 */
async function appendQuoteToThread(
  threadId: string,
  userTurn: string,
  block: string,
): Promise<void> {
  const tag = { claudius_quote: true };
  const graph = await getChatGraph();
  await graph.updateState(
    { configurable: { thread_id: threadId } },
    {
      messages: [
        new HumanMessage({ content: userTurn, additional_kwargs: tag }),
        new AIMessage({ content: block, additional_kwargs: tag }),
      ],
    },
  );
}

/** The outcome of resolving a quote: a rendered block either way. */
interface Resolution {
  markdown: string;
  /** Absent when nothing was fetched (a failure), so nothing is cached. */
  cache?: { key: string; value: QuoteValue };
}

/** Render a cached or freshly fetched instrument value. */
function renderInstrument(
  query: SymbolQuery,
  value: Extract<QuoteValue, { kind: "instrument" }>,
  window: ChangeWindow,
): string {
  const resolved = resolveSymbol(query.symbol);
  return renderQuote({
    requested: query.symbol,
    resolved,
    ...(value.name === undefined ? {} : { name: value.name }),
    ...(value.currency === undefined ? {} : { currency: value.currency }),
    price: value.price,
    change: resolveChange(value.price, value.reference, window),
    marketOpen: value.marketOpen,
    asOf: new Date(value.asOf),
  });
}

/** Render a cached or freshly fetched FX rate at the requested amount. */
function renderRate(
  query: ConvertQuery,
  value: Extract<QuoteValue, { kind: "rate" }>,
): string {
  return renderConversion({
    amount: query.amount,
    from: query.from,
    to: query.to,
    rate: value.rate,
    // FX has no session close, so the window is always 24h here.
    change: resolveChange(value.rate, value.reference, "24h"),
    asOf: new Date(value.asOf),
  });
}

/** Resolve an instrument lookup: cache, then provider. */
async function resolveInstrument(query: SymbolQuery): Promise<Resolution> {
  const resolved = resolveSymbol(query.symbol);
  // A continuous market (crypto, FX pair, metals) has no session close, so the
  // comparison is against 24h ago and the render says which window it used.
  const window: ChangeWindow = resolved.continuous ? "24h" : "previous_close";
  const key = quoteCacheKey(resolved.provider);
  const store = getDefaultQuoteCacheStore();

  const cached = await store.get(key);
  if (cached && cached.kind === "instrument") {
    return { markdown: renderInstrument(query, cached, window) };
  }

  const result = await fetchQuote(resolved.provider);
  if (!result.ok) return { markdown: FAILURE_MESSAGE[result.reason] };

  const value: QuoteValue = {
    kind: "instrument",
    ...(result.data.name === undefined ? {} : { name: result.data.name }),
    ...(result.data.currency === undefined
      ? {}
      : { currency: result.data.currency }),
    price: result.data.price,
    reference: result.data.previousClose,
    marketOpen: result.data.marketOpen,
    asOf: result.data.asOf.toISOString(),
  };
  return {
    markdown: renderInstrument(query, value, window),
    cache: { key, value },
  };
}

/** Resolve a currency conversion: cache, then provider. */
async function resolveConversion(query: ConvertQuery): Promise<Resolution> {
  // Amount-independent by design: every amount for a pair shares one rate and
  // therefore one provider call (see conversionCacheKey).
  const key = conversionCacheKey(query.from, query.to);
  const store = getDefaultQuoteCacheStore();

  const cached = await store.get(key);
  if (cached && cached.kind === "rate") {
    return { markdown: renderRate(query, cached) };
  }

  const result = await fetchExchangeRate(query.from, query.to);
  if (!result.ok) return { markdown: FAILURE_MESSAGE[result.reason] };

  const value: QuoteValue = {
    kind: "rate",
    rate: result.data.rate,
    reference: result.data.reference,
    // FX trades continuously, so there is no closed state to lengthen the TTL.
    marketOpen: true,
    asOf: result.data.asOf.toISOString(),
  };
  return { markdown: renderRate(query, value), cache: { key, value } };
}

/** Resolve either shape of quote query into a renderable block. */
export async function resolveQuote(query: QuoteQuery): Promise<Resolution> {
  return query.kind === "symbol"
    ? await resolveInstrument(query)
    : await resolveConversion(query);
}

export async function handleQuoteTurn(params: {
  userId: ObjectId;
  role: Role;
  modelId: string;
  /** The parsed quote query (the text after `$`). */
  query: QuoteQuery;
  /** The original user text (`$...`), persisted as the human turn. */
  rawText: string;
  /** The owned existing conversation, or null to start a fresh one. */
  conversation: Conversation | null;
}): Promise<Response> {
  const { userId, role, modelId, query, rawText } = params;

  // Resolve BEFORE creating anything: a provider failure then leaves no empty
  // conversation behind, the same discipline the tier gate follows elsewhere.
  const resolution = await resolveQuote(query);

  if (resolution.cache) {
    const store = getDefaultQuoteCacheStore();
    const { key, value } = resolution.cache;
    await store.set(key, value, quoteTtlSeconds(value.marketOpen));
  }

  const isNewConversation = params.conversation === null;
  const conversation =
    params.conversation ??
    (await createConversation({ userId, role, modelId, scratch: true }));
  const conversationObjId = conversation._id!;
  const threadId = conversationObjId.toString();

  // Title from the opening query, before the turn is persisted: only a new
  // conversation is ever titled, so waiting would leave a thread on "New chat"
  // for good if this turn failed.
  if (isNewConversation) {
    after(() =>
      generateTitle({
        userId,
        conversationId: conversationObjId,
        userText: rawText,
      }),
    );
  }

  const block = resolution.markdown;

  const stream = createUIMessageStream<ClaudiusUIMessage>({
    onError: (error) => {
      console.error(
        "Quote stream error:",
        error instanceof Error ? `${error.name}: ${error.message}` : error,
      );
      return isAppError(error) ? error.message : "The quote failed.";
    },
    execute: async ({ writer }) => {
      writer.write({ type: "start" });
      writer.write({
        type: "data-conversation",
        data: { id: threadId, title: conversation.title },
        transient: true,
      });
      writer.write({ type: "start-step" });

      // One part: the block is already complete, so there is nothing to stream
      // incrementally and no provider stream to babysit.
      const textId = "text-0";
      writer.write({ type: "text-start", id: textId });
      writer.write({ type: "text-delta", id: textId, delta: block });
      writer.write({ type: "text-end", id: textId });

      writer.write({ type: "finish-step" });
      writer.write({ type: "finish" });

      await appendQuoteToThread(threadId, rawText, block);
      await touchConversation({
        userId,
        conversationId: conversationObjId,
        preview: block,
        modelId,
        // An operator lookup keeps the thread scratch and pushes its lapse
        // date forward; only a real question promotes it.
        scratch: true,
      });
    },
  });

  return createUIMessageStreamResponse({ stream });
}
