import { describe, expect, it } from "vitest";
import {
  MemoryQuoteCacheStore,
  QUOTE_TTL_CLOSED_SECONDS,
  QUOTE_TTL_OPEN_SECONDS,
  conversionCacheKey,
  parseQuoteQuery,
  quoteCacheKey,
  quoteTtlSeconds,
  renderConversion,
  renderQuote,
  resolveChange,
  resolveSymbol,
} from "./quotes";

/**
 * Quote mode's pure core (Phase 13). The parse table is the important half: `$`
 * has to catch tickers and conversions while leaving every normal sentence that
 * mentions money alone, because a false positive here silently turns a real
 * question into a failed symbol lookup.
 */

describe("parseQuoteQuery", () => {
  it("reads a bare ticker", () => {
    expect(parseQuoteQuery("$MDB")).toEqual({ kind: "symbol", symbol: "MDB" });
  });

  it("uppercases and trims", () => {
    expect(parseQuoteQuery("  $mdb  ")).toEqual({
      kind: "symbol",
      symbol: "MDB",
    });
  });

  it("accepts share classes, exchange suffixes and index spellings", () => {
    expect(parseQuoteQuery("$brk.b")).toEqual({
      kind: "symbol",
      symbol: "BRK.B",
    });
    expect(parseQuoteQuery("$XIC.TO")).toEqual({
      kind: "symbol",
      symbol: "XIC.TO",
    });
    expect(parseQuoteQuery("$S&P")).toEqual({ kind: "symbol", symbol: "S&P" });
  });

  it("reads an amount conversion", () => {
    expect(parseQuoteQuery("$500 CAD to COP")).toEqual({
      kind: "convert",
      amount: 500,
      from: "CAD",
      to: "COP",
    });
  });

  it("accepts `in` as the separator and is case-insensitive", () => {
    expect(parseQuoteQuery("$20 eur in jpy")).toEqual({
      kind: "convert",
      amount: 20,
      from: "EUR",
      to: "JPY",
    });
  });

  it("expands k and m suffixes and strips thousands separators", () => {
    expect(parseQuoteQuery("$1.5k usd to eur")).toMatchObject({ amount: 1500 });
    expect(parseQuoteQuery("$2m usd to eur")).toMatchObject({ amount: 2_000_000 });
    expect(parseQuoteQuery("$1,500 usd to eur")).toMatchObject({ amount: 1500 });
  });

  it("defaults a missing amount to 1 — the bare-rate question", () => {
    expect(parseQuoteQuery("$CAD to COP")).toEqual({
      kind: "convert",
      amount: 1,
      from: "CAD",
      to: "COP",
    });
  });

  it("treats a lone currency code as a rate against USD, not a ticker", () => {
    expect(parseQuoteQuery("$COP")).toEqual({
      kind: "convert",
      amount: 1,
      from: "COP",
      to: "USD",
    });
  });

  // The negative cases. Each of these must fall through to a normal chat turn.
  it.each([
    ["a bare dollar sign", "$"],
    ["a doubled dollar sign", "$$"],
    ["a doubled sign with content", "$$MDB"],
    ["a sentence starting with a price", "$500 is a lot of money for a keyboard"],
    ["a sentence that merely mentions money", "how much is $500 in colombian pesos"],
    ["a multi-word non-conversion", "$MDB vs ORCL"],
    ["an unknown separator", "$500 CAD into COP"],
    ["an unknown source currency", "$500 XXX to COP"],
    ["an unknown target currency", "$500 CAD to XXX"],
    ["an unparseable amount", "$five hundred CAD to COP"],
    ["a too-long token", "$ABCDEFGHIJKLMNOP"],
    ["a token with prose punctuation", "$what?"],
    ["no leading dollar sign", "MDB"],
    ["an empty string", ""],
  ])("is not a quote: %s", (_label, input) => {
    expect(parseQuoteQuery(input)).toBeNull();
  });

  it("rejects a zero or negative amount", () => {
    expect(parseQuoteQuery("$0 CAD to COP")).toBeNull();
    expect(parseQuoteQuery("$-5 CAD to COP")).toBeNull();
  });
});

describe("resolveSymbol", () => {
  it("passes an unknown ticker through untouched — the provider is the authority", () => {
    expect(resolveSymbol("MDB")).toEqual({ provider: "MDB", continuous: false });
  });

  it("maps an index to its tracking ETF and records the proxy", () => {
    const resolved = resolveSymbol("S&P");
    expect(resolved.provider).toBe("SPY");
    expect(resolved.proxyFor).toBe("the S&P 500");
    // An ETF trades on a session, so this is NOT continuous.
    expect(resolved.continuous).toBe(false);
  });

  it("maps crypto to a pair and marks it continuous", () => {
    expect(resolveSymbol("BTC")).toEqual({
      provider: "BTC/USD",
      continuous: true,
    });
  });

  it("marks a metals pair continuous and claims no proxy", () => {
    const gold = resolveSymbol("gold");
    expect(gold.provider).toBe("XAU/USD");
    expect(gold.continuous).toBe(true);
    expect(gold.proxyFor).toBeUndefined();
  });
});

describe("resolveChange", () => {
  it("computes an upward move", () => {
    const change = resolveChange(110, 100, "previous_close");
    expect(change).toEqual({
      absolute: 10,
      percent: 10,
      direction: "up",
      window: "previous_close",
    });
  });

  it("computes a downward move and keeps the window it was given", () => {
    const change = resolveChange(90, 100, "24h");
    expect(change).toMatchObject({
      absolute: -10,
      percent: -10,
      direction: "down",
      window: "24h",
    });
  });

  it("reports flat when the price equals its reference (a closed market)", () => {
    expect(resolveChange(100, 100, "previous_close")).toMatchObject({
      direction: "flat",
      absolute: 0,
    });
  });

  // No reference means no comparison — never an infinite or invented percentage.
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["zero", 0],
    ["not a number", Number.NaN],
  ])("returns null when the reference is %s", (_label, reference) => {
    expect(resolveChange(100, reference, "previous_close")).toBeNull();
  });
});

describe("renderQuote", () => {
  const base = {
    requested: "MDB",
    resolved: { provider: "MDB", continuous: false },
    name: "MongoDB Inc",
    currency: "USD",
    price: 250.5,
    marketOpen: true,
    asOf: new Date("2026-08-10T15:30:00Z"),
  };

  it("shows the price, the delta, the window and the market state", () => {
    const block = renderQuote({
      ...base,
      change: resolveChange(250.5, 240, "previous_close"),
    });
    expect(block).toContain("250.50");
    expect(block).toContain("MongoDB Inc");
    expect(block).toContain("▲");
    expect(block).toContain("vs. previous close");
    expect(block).toContain("Market open");
    expect(block).toContain("2026-08-10 15:30:00 UTC");
    expect(block).toContain("not investment advice");
  });

  it("labels a continuous instrument's comparison as 24h", () => {
    const block = renderQuote({
      ...base,
      requested: "BTC",
      resolved: { provider: "BTC/USD", continuous: true },
      change: resolveChange(100, 120, "24h"),
    });
    expect(block).toContain("vs. 24h ago");
    expect(block).toContain("▼");
  });

  // The disclosure is the whole point of the proxy design: quietly answering
  // `$S&P` with an ETF price would be a wrong answer dressed as a right one.
  it("discloses an index proxy", () => {
    const block = renderQuote({
      ...base,
      requested: "S&P",
      resolved: { provider: "SPY", proxyFor: "the S&P 500", continuous: false },
      change: null,
    });
    expect(block).toContain("SPY");
    expect(block).toContain("the S&P 500");
    expect(block).toContain("proxy");
  });

  it("says so plainly when there is no comparison", () => {
    const block = renderQuote({ ...base, change: null });
    expect(block).toContain("No comparison available");
  });

  it("reports a closed market", () => {
    const block = renderQuote({ ...base, marketOpen: false, change: null });
    expect(block).toContain("Market closed");
  });
});

describe("renderConversion", () => {
  it("shows the converted amount AND the rate used", () => {
    const block = renderConversion({
      amount: 500,
      from: "CAD",
      to: "COP",
      rate: 2900.1234,
      change: resolveChange(2900.1234, 2880, "24h"),
      asOf: new Date("2026-08-10T15:30:00Z"),
    });
    // 500 × 2900.1234 = 1,450,061.70
    expect(block).toContain("1,450,061.70");
    expect(block).toContain("1 CAD = 2,900.12 COP");
    expect(block).toContain("vs. 24h ago");
  });

  it("renders a bare rate at amount 1", () => {
    const block = renderConversion({
      amount: 1,
      from: "CAD",
      to: "COP",
      rate: 2900,
      change: null,
      asOf: new Date("2026-08-10T15:30:00Z"),
    });
    expect(block).toContain("1 CAD = 2,900.00 COP");
  });
});

describe("the quote cache", () => {
  it("keys an instrument by its resolved provider symbol, case-insensitively", () => {
    expect(quoteCacheKey("SPY")).toBe(quoteCacheKey("spy"));
    expect(quoteCacheKey("SPY")).not.toBe(quoteCacheKey("QQQ"));
  });

  // The design point: every amount for a pair shares one rate, so one provider
  // call serves all of them.
  it("keys a conversion by pair only, never by amount", () => {
    expect(conversionCacheKey("CAD", "COP")).toBe(
      conversionCacheKey("cad", "cop"),
    );
    expect(conversionCacheKey("CAD", "COP")).not.toBe(
      conversionCacheKey("COP", "CAD"),
    );
  });

  it("picks a short TTL for an open market and a long one for a closed market", () => {
    expect(quoteTtlSeconds(true)).toBe(QUOTE_TTL_OPEN_SECONDS);
    expect(quoteTtlSeconds(false)).toBe(QUOTE_TTL_CLOSED_SECONDS);
    expect(QUOTE_TTL_CLOSED_SECONDS).toBeGreaterThan(QUOTE_TTL_OPEN_SECONDS);
  });

  it("serves an entry inside its TTL and drops it after", async () => {
    let now = 1_000_000;
    const store = new MemoryQuoteCacheStore(() => now);
    const value = {
      kind: "instrument" as const,
      price: 250,
      reference: 240,
      marketOpen: true,
      asOf: new Date().toISOString(),
    };

    await store.set("k", value, QUOTE_TTL_OPEN_SECONDS);
    expect(await store.get("k")).toEqual(value);

    now += (QUOTE_TTL_OPEN_SECONDS + 1) * 1000;
    expect(await store.get("k")).toBeNull();
  });
});
