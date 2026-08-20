import { ObjectId } from "mongodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Conversation } from "@claudius/shared";

/**
 * The quote turn's control flow (Phase 13). The properties worth pinning down are
 * the cost ones, because they are what the phase claims: a quote runs NO model on
 * any branch (no gate, no usage row), a cache hit makes no provider call, and a
 * provider failure renders a message rather than a number.
 */

const fetchQuote = vi.fn();
const fetchExchangeRate = vi.fn();
const cacheGet = vi.fn<() => Promise<unknown>>(async () => null);
const cacheSet = vi.fn(async () => {});
const updateState = vi.fn(async () => {});
const touchConversation = vi.fn(async () => {});
// These two must never be reached on this path — that is the invariant.
const assertCanInvoke = vi.fn(async () => {
  throw new Error("assertCanInvoke must not run on the quote path");
});
const writeUsageEvent = vi.fn(async () => {
  throw new Error("writeUsageEvent must not run on the quote path");
});

vi.mock("@claudius/shared", async (importOriginal) => ({
  // Keep the real parser, alias table, change arithmetic and renderers: the test
  // is about control flow, not about re-testing those.
  ...(await importOriginal<typeof import("@claudius/shared")>()),
  assertCanInvoke: (...args: unknown[]) => assertCanInvoke(...(args as [])),
  writeUsageEvent: (...args: unknown[]) => writeUsageEvent(...(args as [])),
  fetchQuote: (...args: unknown[]) => fetchQuote(...(args as [])),
  fetchExchangeRate: (...args: unknown[]) =>
    fetchExchangeRate(...(args as [])),
  getChatGraph: async () => ({ updateState }),
  getDefaultQuoteCacheStore: () => ({ get: cacheGet, set: cacheSet }),
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

const { handleQuoteTurn } = await import("./quotes");
const { parseQuoteQuery } = await import("@claudius/shared");

/** Run a turn from raw `$` text, exactly as the route would. */
async function run(rawText: string): Promise<string> {
  const query = parseQuoteQuery(rawText);
  if (!query) throw new Error(`not a quote query: ${rawText}`);
  const response = await handleQuoteTurn({
    userId: conversation.userId,
    role: "member",
    modelId: "opus",
    query,
    rawText,
    conversation,
  });
  return await response.text();
}

/** The assistant text the turn persisted through the graph reducer. */
function persistedBlock(): string {
  expect(updateState).toHaveBeenCalledTimes(1);
  const call = updateState.mock.calls[0] as unknown as
    | [unknown, { messages: { content: string }[] }]
    | undefined;
  if (!call) throw new Error("updateState was never called");
  const assistant = call[1].messages[1];
  if (!assistant) throw new Error("no assistant message was persisted");
  return assistant.content;
}

const openQuote = {
  ok: true as const,
  data: {
    symbol: "MDB",
    name: "MongoDB Inc",
    currency: "USD",
    price: 250,
    previousClose: 240,
    marketOpen: true,
    asOf: new Date("2026-08-10T15:30:00Z"),
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  cacheGet.mockResolvedValue(null);
  fetchQuote.mockResolvedValue(openQuote);
});

describe("handleQuoteTurn — an instrument", () => {
  it("streams the rendered block and persists it, with no model call at all", async () => {
    const body = await run("$MDB");

    expect(body).toContain("250.00");
    expect(persistedBlock()).toContain("MongoDB Inc");
    // The phase's central cost claim.
    expect(assertCanInvoke).not.toHaveBeenCalled();
    expect(writeUsageEvent).not.toHaveBeenCalled();
  });

  it("keeps the thread scratch, so a bare lookup does not clutter the sidebar", async () => {
    await run("$MDB");
    expect(touchConversation).toHaveBeenCalledWith(
      expect.objectContaining({ scratch: true }),
    );
  });

  it("caches the fetched value with the open-market TTL", async () => {
    await run("$MDB");
    expect(cacheSet).toHaveBeenCalledTimes(1);
    const [, value, ttl] = cacheSet.mock.calls[0] as unknown as [
      string,
      { kind: string; price: number },
      number,
    ];
    expect(value).toMatchObject({ kind: "instrument", price: 250 });
    expect(ttl).toBe(60);
  });

  it("uses the long TTL once the market has closed", async () => {
    fetchQuote.mockResolvedValue({
      ok: true,
      data: { ...openQuote.data, marketOpen: false },
    });
    await run("$MDB");
    const [, , ttl] = cacheSet.mock.calls[0] as unknown as [
      string,
      unknown,
      number,
    ];
    expect(ttl).toBe(30 * 60);
  });

  it("serves a cache hit without calling the provider or re-caching", async () => {
    cacheGet.mockResolvedValue({
      kind: "instrument",
      name: "MongoDB Inc",
      currency: "USD",
      price: 251,
      reference: 240,
      marketOpen: true,
      asOf: "2026-08-10T15:30:00.000Z",
    });

    const body = await run("$MDB");

    expect(body).toContain("251.00");
    expect(fetchQuote).not.toHaveBeenCalled();
    expect(cacheSet).not.toHaveBeenCalled();
  });

  it("asks the provider for the resolved proxy and discloses it", async () => {
    fetchQuote.mockResolvedValue({
      ok: true,
      data: { ...openQuote.data, symbol: "SPY", name: "SPDR S&P 500 ETF" },
    });

    const body = await run("$S&P");

    expect(fetchQuote).toHaveBeenCalledWith("SPY");
    expect(body).toContain("the S&P 500");
    expect(body).toContain("proxy");
  });

  it("compares crypto against 24h rather than a session close", async () => {
    fetchQuote.mockResolvedValue({
      ok: true,
      data: { ...openQuote.data, symbol: "BTC/USD", name: "Bitcoin" },
    });

    const body = await run("$BTC");

    expect(fetchQuote).toHaveBeenCalledWith("BTC/USD");
    expect(body).toContain("vs. 24h ago");
    expect(body).not.toContain("vs. previous close");
  });
});

describe("handleQuoteTurn — a conversion", () => {
  const rate = {
    ok: true as const,
    data: {
      from: "CAD",
      to: "COP",
      rate: 2900,
      reference: 2880,
      asOf: new Date("2026-08-10T15:30:00Z"),
    },
  };

  it("returns the converted amount and the rate used", async () => {
    fetchExchangeRate.mockResolvedValue(rate);
    const body = await run("$500 CAD to COP");
    expect(fetchExchangeRate).toHaveBeenCalledWith("CAD", "COP");
    expect(body).toContain("1,450,000.00");
    expect(body).toContain("1 CAD = 2,900.00 COP");
    expect(writeUsageEvent).not.toHaveBeenCalled();
  });

  // The reason the conversion cache is keyed by pair alone.
  it("re-renders a cached rate at a different amount with no provider call", async () => {
    cacheGet.mockResolvedValue({
      kind: "rate",
      rate: 2900,
      reference: 2880,
      marketOpen: true,
      asOf: "2026-08-10T15:30:00.000Z",
    });

    const body = await run("$20 CAD to COP");

    expect(fetchExchangeRate).not.toHaveBeenCalled();
    expect(body).toContain("58,000.00");
  });
});

describe("handleQuoteTurn — provider failures", () => {
  // Every branch must render a message, never a fabricated number.
  it.each([
    ["unknown_symbol", "couldn't find that symbol"],
    ["rate_limited", "rate limit"],
    ["provider_error", "didn't respond"],
    ["not_configured", "no market-data provider configured"],
  ])("renders a safe message for %s", async (reason, expected) => {
    fetchQuote.mockResolvedValue({ ok: false, reason });

    const body = await run("$NOPE");

    expect(body).toContain(expected);
    expect(cacheSet).not.toHaveBeenCalled();
    expect(writeUsageEvent).not.toHaveBeenCalled();
    // The failure is still an honest turn in the thread, not a silent no-op.
    expect(updateState).toHaveBeenCalledTimes(1);
  });
});
