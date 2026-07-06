import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SearchSettings } from "../db/schemas";
import { isAppError } from "../errors";
import type { SearchResult } from "./types";

/**
 * Source-selection tests — the cost-tiered routing rule is the heart of Phase 7.
 * The two backends and the settings loader are mocked so each branch (Brave
 * primary, quota exhaustion, Brave error, high-value gate, quality gate, both
 * down) is exercised in isolation without a network or a database.
 */

const braveSearch = vi.fn<(q: string, n?: number) => Promise<SearchResult[]>>();
const tavilySearch =
  vi.fn<
    (q: string, n?: number, d?: "basic" | "advanced") => Promise<SearchResult[]>
  >();
const loadSearchSettings = vi.fn<() => Promise<SearchSettings>>();
const recordBraveCall = vi.fn<() => Promise<number>>();

// The real error class so `instanceof BraveSearchError` narrows in search.ts.
class BraveSearchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BraveSearchError";
  }
}

vi.mock("./brave", () => ({
  braveSearch: (q: string, n?: number) => braveSearch(q, n),
  BraveSearchError,
}));
vi.mock("./tavily", () => ({
  tavilySearch: (q: string, n?: number, d?: "basic" | "advanced") =>
    tavilySearch(q, n, d),
}));
vi.mock("../tiers/catalog", () => ({
  loadSearchSettings: () => loadSearchSettings(),
  braveCountThisMonth: (usage: SearchSettings["braveUsage"]) => usage.count,
  recordBraveCall: () => recordBraveCall(),
}));

const { answerSearch } = await import("./search");

function settings(overrides: Partial<SearchSettings> = {}): SearchSettings {
  return {
    _id: "search",
    braveMonthlyThreshold: 1000,
    braveUsage: { month: "2026-07", count: 0 },
    highValueMinResults: 3,
    ...overrides,
  };
}

function hits(n: number): SearchResult[] {
  return Array.from({ length: n }, (_, i) => ({
    title: `t${i}`,
    url: `https://e.com/${i}`,
    snippet: `s${i}`,
  }));
}

describe("answerSearch source selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadSearchSettings.mockResolvedValue(settings());
    recordBraveCall.mockResolvedValue(1);
    braveSearch.mockResolvedValue(hits(5));
    tavilySearch.mockResolvedValue(hits(5));
  });

  it("uses Brave by default under the monthly threshold", async () => {
    const out = await answerSearch({ query: "who won yesterday" });
    expect(out.source).toBe("brave");
    expect(out.reason).toBe("brave_primary");
    expect(braveSearch).toHaveBeenCalledOnce();
    expect(tavilySearch).not.toHaveBeenCalled();
    // The call is metered against the free-tier allowance.
    expect(recordBraveCall).toHaveBeenCalledOnce();
  });

  it("falls back to Tavily when the Brave monthly allowance is exhausted", async () => {
    loadSearchSettings.mockResolvedValue(
      settings({
        braveMonthlyThreshold: 100,
        braveUsage: { month: "2026-07", count: 100 },
      }),
    );
    const out = await answerSearch({ query: "current price of gold" });
    expect(out.source).toBe("tavily");
    expect(out.reason).toBe("brave_quota_exhausted");
    expect(braveSearch).not.toHaveBeenCalled();
    // No Brave call means no Brave quota spent on an exhausted month.
    expect(recordBraveCall).not.toHaveBeenCalled();
    expect(tavilySearch).toHaveBeenCalledWith(
      "current price of gold",
      undefined,
      "basic",
    );
  });

  it("falls back to Tavily when Brave errors or times out", async () => {
    braveSearch.mockRejectedValue(new BraveSearchError("timeout"));
    const out = await answerSearch({ query: "latest release notes" });
    expect(out.source).toBe("tavily");
    expect(out.reason).toBe("brave_error");
    // Brave was attempted (and its quota spent) before it failed.
    expect(recordBraveCall).toHaveBeenCalledOnce();
    expect(tavilySearch).toHaveBeenCalledOnce();
  });

  it("routes high-value requests straight to Tavily advanced, skipping Brave", async () => {
    const out = await answerSearch({ query: "deep dive", highValue: true });
    expect(out.source).toBe("tavily");
    expect(out.reason).toBe("high_value_gate");
    expect(braveSearch).not.toHaveBeenCalled();
    expect(recordBraveCall).not.toHaveBeenCalled();
    expect(tavilySearch).toHaveBeenCalledWith("deep dive", undefined, "advanced");
  });

  it("retries on Tavily when Brave returns too few usable results", async () => {
    braveSearch.mockResolvedValue(hits(1)); // below highValueMinResults (3)
    const out = await answerSearch({ query: "obscure query" });
    expect(out.source).toBe("tavily");
    expect(out.reason).toBe("brave_low_quality");
    expect(braveSearch).toHaveBeenCalledOnce();
    expect(tavilySearch).toHaveBeenCalledOnce();
  });

  it("surfaces a user-safe AppError when BOTH backends are unavailable", async () => {
    braveSearch.mockRejectedValue(new BraveSearchError("down"));
    tavilySearch.mockRejectedValue(new Error("tavily down too"));
    try {
      await answerSearch({ query: "anything" });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(isAppError(err)).toBe(true);
      if (isAppError(err)) {
        expect(err.code).toBe("internal");
        // No internal detail leaks into the user-facing message.
        expect(err.message).not.toContain("tavily");
        expect(err.message).not.toContain("down");
      }
    }
  });

  it("does not mask a non-Brave fault (misconfigured settings) as a fallback", async () => {
    recordBraveCall.mockRejectedValue(new Error("settings missing"));
    // A recordBraveCall failure is a real internal fault, not a backend hiccup,
    // so it propagates rather than silently degrading to Tavily.
    await expect(answerSearch({ query: "x" })).rejects.toThrow(/settings missing/);
    expect(tavilySearch).not.toHaveBeenCalled();
  });
});
