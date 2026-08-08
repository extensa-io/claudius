import { AIMessageChunk } from "@langchain/core/messages";
import { ObjectId } from "mongodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Conversation, InvokeGrant } from "@claudius/shared";

/**
 * The dictionary turn's failure behaviour. Bedrock can drop a streaming Converse
 * call mid-generation (the InternalServerException arrives as an event inside an
 * already-open stream, so the SDK's pre-response retries never see it), which is
 * how this path actually fails in production. What matters is what survives: the
 * text the user already watched arrive is billed and persisted, and a truncated
 * entry never reaches the 30-day global cache.
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
  // Set per test.
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
    // A clean stream ends with the usage-bearing chunk (streamUsage: true).
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
  // Keep the real prompt builder, language heuristic, cache key and AppError:
  // the test is about control flow, not about re-testing those.
  ...(await importOriginal<typeof import("@claudius/shared")>()),
  assertCanInvoke: (...args: unknown[]) => assertCanInvoke(...(args as [])),
  writeUsageEvent: (...args: unknown[]) => writeUsageEvent(...(args as [])),
  buildChatModel: () => ({ stream: modelStream }),
  getChatGraph: async () => ({ updateState }),
  getDefaultDictionaryCacheStore: () => ({ get: cacheGet, set: cacheSet }),
}));

vi.mock("./conversations", () => ({
  createConversation: async () => conversation,
  touchConversation: (...args: unknown[]) =>
    touchConversation(...(args as [])),
}));

vi.mock("./titleGen", () => ({ generateTitle: async () => {} }));

// `after` would otherwise defer work past the test; the title path is not
// what is under test here.
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

const { handleDictionaryTurn } = await import("./dictionary");

// --- Helpers -------------------------------------------------------------

async function run(
  options: { signal?: AbortSignal } = {},
): Promise<{ response: Response; body: string }> {
  const response = await handleDictionaryTurn({
    userId: conversation.userId,
    role: "member",
    modelId: "opus",
    term: "solipsist",
    rawText: "?solipsist",
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

describe("handleDictionaryTurn on a truncated stream", () => {
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
    scripted = { deltas: ["**solipsist** *(noun)*\n\n1. "], throwAfter: truncate() };

    const { body } = await run();

    // The user keeps what they watched arrive.
    expect(body).toContain("solipsist");
    expect(persistedEntry()).toContain("**solipsist** *(noun)*");
    expect(touchConversation).toHaveBeenCalledTimes(1);
  });

  it("appends a notice so the entry does not look merely terse", async () => {
    scripted = { deltas: ["**solipsist**"], throwAfter: truncate() };

    await run();

    expect(persistedEntry()).toMatch(/cut short by a provider error/);
  });

  it("never caches a truncated entry", async () => {
    scripted = { deltas: ["**solipsist**"], throwAfter: truncate() };

    await run();

    // A 30-day TTL on a content-only global key would otherwise serve one bad
    // stream to every future lookup of the term.
    expect(cacheSet).not.toHaveBeenCalled();
  });

  it("still writes exactly one usage_events row (invariant #3)", async () => {
    scripted = { deltas: ["**solipsist**"], throwAfter: truncate() };

    await run();

    expect(writeUsageEvent).toHaveBeenCalledTimes(1);
    const [event] = writeUsageEvent.mock.calls[0] as unknown as [
      { purpose: string; outputTokens: number },
    ];
    expect(event.purpose).toBe("dictionary");
    // The usage-bearing final chunk never arrived, so the row undercounts
    // rather than inventing an estimate.
    expect(event.outputTokens).toBe(0);
  });

  it("omits the notice when the user aborted the turn themselves", async () => {
    const controller = new AbortController();
    scripted = { deltas: ["**solipsist**"], throwAfter: truncate() };
    onBeforeThrow = () => controller.abort();

    await run({ signal: controller.signal });

    expect(persistedEntry()).not.toMatch(/cut short/);
    expect(cacheSet).not.toHaveBeenCalled();
  });

  it("surfaces the error and persists nothing when no text arrived", async () => {
    scripted = { deltas: [], throwAfter: truncate() };

    const { body } = await run();

    expect(body).toContain("The lookup failed.");
    expect(updateState).not.toHaveBeenCalled();
    expect(touchConversation).not.toHaveBeenCalled();
    expect(cacheSet).not.toHaveBeenCalled();
  });
});

describe("handleDictionaryTurn on a clean stream", () => {
  it("caches the entry and records real token counts", async () => {
    scripted = { deltas: ["**solipsist** *(noun)*", "\n\nTranslation: solipsista"], throwAfter: null };

    await run();

    expect(cacheSet).toHaveBeenCalledTimes(1);
    const [, value] = cacheSet.mock.calls[0] as unknown as [
      string,
      { markdown: string },
    ];
    expect(value.markdown).toContain("solipsista");
    expect(persistedEntry()).not.toMatch(/cut short/);

    const [event] = writeUsageEvent.mock.calls[0] as unknown as [
      { inputTokens: number; outputTokens: number },
    ];
    expect(event.outputTokens).toBe(40);
  });

  it("makes no model call and consumes nothing on a cache hit", async () => {
    cacheGet.mockResolvedValue({
      markdown: "**solipsist** (cached)",
      sourceLang: "en",
    } as never);

    const { body } = await run();

    expect(modelStream).not.toHaveBeenCalled();
    expect(assertCanInvoke).not.toHaveBeenCalled();
    expect(writeUsageEvent).not.toHaveBeenCalled();
    expect(body).toContain("(cached)");
  });
});
