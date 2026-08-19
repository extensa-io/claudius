import { AIMessageChunk } from "@langchain/core/messages";
import { ObjectId } from "mongodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Conversation, InvokeGrant, TranslateQuery } from "@claudius/shared";
import { LOOKUP_MODEL_ID } from "./lookupModel";

/**
 * The translate turn's cost contract and failure behaviour. Same two things
 * matter as on the dictionary path: a cache hit must run no model and consume
 * nothing, and a stream Bedrock drops mid-entry must keep the text the user
 * already watched arrive without poisoning the 30-day global cache with it.
 */

// --- What the module under test reaches for, all captured ----------------

const grant: InvokeGrant = {
  modelId: "opus",
  inferenceProfileId: "us.anthropic.claude-opus-4-8",
  displayName: "Claude Opus",
  role: "member",
  memoryEnabled: true,
  supportsImages: false,
  imagePolicy: { maxPerTurn: 0, maxLongEdgePx: 1568, enforcement: "hard" },
};

/** Chunks to yield, then an optional error to throw mid-stream. */
let scripted: { deltas: string[]; throwAfter: Error | null } = {
  deltas: [],
  throwAfter: null,
};
/** Called just before the scripted error is thrown, so a test can abort. */
let onBeforeThrow: (() => void) | null = null;
/** Usage on the final chunk. Absent on a truncated stream, as in production. */
let finalUsage: { input_tokens: number; output_tokens: number } | null = null;

const assertCanInvoke = vi.fn(async () => grant);
const writeUsageEvent = vi.fn(async () => {});
const cacheGet = vi.fn(async () => null);
const cacheSet = vi.fn(async () => {});
const updateState = vi.fn(async () => {});
const touchConversation = vi.fn(async () => {});

const modelStream = vi.fn(async () => {
  async function* gen(): AsyncGenerator<AIMessageChunk> {
    for (const delta of scripted.deltas) {
      yield new AIMessageChunk({ content: delta });
    }
    if (scripted.throwAfter) {
      onBeforeThrow?.();
      throw scripted.throwAfter;
    }
    const final = new AIMessageChunk({ content: "" });
    if (finalUsage) {
      // Attached rather than declared: the installed @langchain/core types
      // narrow usage_metadata to undefined on a chunk, which is why the module
      // under test reads it through a cast too.
      Object.assign(final, {
        usage_metadata: {
          input_tokens: finalUsage.input_tokens,
          output_tokens: finalUsage.output_tokens,
          total_tokens: finalUsage.input_tokens + finalUsage.output_tokens,
        },
      });
    }
    yield final;
  }
  return gen();
});

vi.mock("@claudius/shared", async (importOriginal) => ({
  // Keep the real prompt builder and cache key: the test is about control flow.
  ...(await importOriginal<typeof import("@claudius/shared")>()),
  assertCanInvoke: (...args: unknown[]) => assertCanInvoke(...(args as [])),
  writeUsageEvent: (...args: unknown[]) => writeUsageEvent(...(args as [])),
  buildChatModel: () => ({ stream: modelStream }),
  getChatGraph: async () => ({ updateState }),
  getDefaultTranslationCacheStore: () => ({ get: cacheGet, set: cacheSet }),
}));

vi.mock("./conversations", () => ({
  createConversation: async () => conversation,
  touchConversation: (...args: unknown[]) => touchConversation(...(args as [])),
}));

vi.mock("./titleGen", () => ({ generateTitle: async () => {} }));
vi.mock("next/server", () => ({ after: () => {} }));

const conversationId = new ObjectId();
const conversation: Conversation = {
  _id: conversationId,
  userId: new ObjectId(),
  title: "New chat",
  modelId: "opus",
  createdAt: new Date(),
  updatedAt: new Date(),
  archived: false,
};

const { handleTranslateTurn } = await import("./translate");

// --- Helpers -------------------------------------------------------------

const AUTO: TranslateQuery = {
  text: "good morning",
  source: null,
  target: "it",
};

async function run(
  options: {
    signal?: AbortSignal;
    query?: TranslateQuery;
    role?: "guest" | "member" | "admin";
  } = {},
): Promise<{ response: Response; body: string }> {
  const query = options.query ?? AUTO;
  const response = await handleTranslateTurn({
    userId: conversation.userId,
    role: options.role ?? "member",
    modelId: "opus",
    query,
    rawText: `&${query.target} ${query.text}`,
    conversation,
    signal: options.signal ?? new AbortController().signal,
  });
  const body = await response.text();
  return { response, body };
}

/** The assistant text the turn persisted through the graph reducer. */
function persistedEntry(): string {
  expect(updateState).toHaveBeenCalledTimes(1);
  const call = updateState.mock.calls[0] as unknown as
    | [unknown, { messages: { content: string }[] }]
    | undefined;
  if (!call) throw new Error("updateState was never called");
  const assistant = call[1].messages[1];
  if (!assistant) throw new Error("no assistant message was persisted");
  return assistant.content;
}

beforeEach(() => {
  vi.clearAllMocks();
  cacheGet.mockResolvedValue(null);
  scripted = { deltas: [], throwAfter: null };
  onBeforeThrow = null;
  finalUsage = { input_tokens: 120, output_tokens: 40 };
});

// --- Tests ---------------------------------------------------------------

describe("handleTranslateTurn on a clean stream", () => {
  it("caches the entry with its direction and records real token counts", async () => {
    scripted = { deltas: ["## buon giorno", "\n\nAlso: buongiorno"], throwAfter: null };

    await run();

    expect(cacheSet).toHaveBeenCalledTimes(1);
    const [, value] = cacheSet.mock.calls[0] as unknown as [
      string,
      { markdown: string; sourceLang: string; targetLang: string },
    ];
    expect(value.markdown).toContain("buon giorno");
    // The auto form stores `auto`, not the language the model turned out to
    // detect: the key was computed before the call, so anything else would make
    // the document disagree with its own _id.
    expect(value.sourceLang).toBe("auto");
    expect(value.targetLang).toBe("it");

    const [event] = writeUsageEvent.mock.calls[0] as unknown as [
      { purpose: string; outputTokens: number },
    ];
    expect(event.purpose).toBe("translation");
    expect(event.outputTokens).toBe(40);
  });

  it("stores the asserted source on the explicit form", async () => {
    scripted = { deltas: ["## buon giorno"], throwAfter: null };

    await run({
      query: { text: "buenos dias", source: "es", target: "it" },
    });

    const [, value] = cacheSet.mock.calls[0] as unknown as [
      string,
      { sourceLang: string },
    ];
    expect(value.sourceLang).toBe("es");
  });

  it("makes no model call and consumes nothing on a cache hit", async () => {
    cacheGet.mockResolvedValue({
      markdown: "## buon giorno (cached)",
      sourceLang: "auto",
      targetLang: "it",
    } as never);

    const { body } = await run();

    expect(modelStream).not.toHaveBeenCalled();
    expect(assertCanInvoke).not.toHaveBeenCalled();
    expect(writeUsageEvent).not.toHaveBeenCalled();
    expect(body).toContain("(cached)");
  });

  it("gates a guest's miss exactly like any other role", async () => {
    scripted = { deltas: ["## buon giorno"], throwAfter: null };

    await run({ role: "guest" });

    // Unlike the quote path, `&` is open to guests — so the gate and the usage
    // row are what keep the exposure sized (invariant #3).
    expect(assertCanInvoke).toHaveBeenCalledTimes(1);
    expect(writeUsageEvent).toHaveBeenCalledTimes(1);
  });

  it("gates on the PINNED lookup model, not the user's selection", async () => {
    scripted = { deltas: ["## buon giorno"], throwAfter: null };

    await run();

    // The user's picker says "opus"; the lookup runs on the pinned model. The
    // pin is also what keeps this path open to guests, for whom "sonnet" and
    // "opus" are not permitted at all.
    const [, gatedModelId] = assertCanInvoke.mock.calls[0] as unknown as [
      unknown,
      string,
    ];
    expect(gatedModelId).toBe(LOOKUP_MODEL_ID);
  });

  it("never switches the thread's model to the pinned one", async () => {
    scripted = { deltas: ["## buon giorno"], throwAfter: null };

    await run();

    // conversation.modelId drives the sidebar and the model picker, so a lookup
    // that wrote the pinned model here would silently change the user's
    // selection for the whole thread.
    const [touch] = touchConversation.mock.calls[0] as unknown as [
      { modelId: string },
    ];
    expect(touch.modelId).toBe("opus");
  });
});

describe("handleTranslateTurn on a truncated stream", () => {
  const truncate = (): Error => {
    const error = new Error(
      "The system encountered an unexpected error during processing. Try your request again.",
    );
    error.cause = Object.assign(new Error("internal"), {
      name: "InternalServerException",
    });
    return error;
  };

  it("persists the partial entry instead of losing the turn", async () => {
    scripted = { deltas: ["## buon giorno\n\n"], throwAfter: truncate() };

    const { body } = await run();

    expect(body).toContain("buon giorno");
    expect(persistedEntry()).toContain("buon giorno");
    expect(touchConversation).toHaveBeenCalledTimes(1);
  });

  it("appends a notice and never caches the partial entry", async () => {
    scripted = { deltas: ["## buon giorno"], throwAfter: truncate() };

    await run();

    expect(persistedEntry()).toMatch(/cut short by a provider error/);
    expect(cacheSet).not.toHaveBeenCalled();
  });

  it("still writes exactly one usage_events row (invariant #3)", async () => {
    scripted = { deltas: ["## buon giorno"], throwAfter: truncate() };

    await run();

    expect(writeUsageEvent).toHaveBeenCalledTimes(1);
    const [event] = writeUsageEvent.mock.calls[0] as unknown as [
      { purpose: string; outputTokens: number },
    ];
    expect(event.purpose).toBe("translation");
    // The usage-bearing final chunk never arrived, so the row undercounts
    // rather than inventing an estimate.
    expect(event.outputTokens).toBe(0);
  });

  it("omits the notice when the user aborted the turn themselves", async () => {
    const controller = new AbortController();
    scripted = { deltas: ["## buon giorno"], throwAfter: truncate() };
    onBeforeThrow = () => controller.abort();

    await run({ signal: controller.signal });

    expect(persistedEntry()).not.toMatch(/cut short/);
    expect(cacheSet).not.toHaveBeenCalled();
  });

  it("surfaces the error and persists nothing when no text arrived", async () => {
    scripted = { deltas: [], throwAfter: truncate() };

    const { body } = await run();

    expect(body).toContain("The translation failed.");
    expect(updateState).not.toHaveBeenCalled();
    expect(touchConversation).not.toHaveBeenCalled();
    expect(cacheSet).not.toHaveBeenCalled();
  });
});
