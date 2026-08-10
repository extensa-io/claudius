import { createHash } from "node:crypto";
import { quoteCacheCol } from "../db/collections";
import type { QuoteCacheEntry, QuoteValue } from "../db/schemas";
import { QUOTE_ALIASES } from "./defaults";

/**
 * Quote mode (Phase 13): a leading `$` is an explicit market-data operator.
 * `$MDB` quotes a stock, `$S&P` an index, `$BTC` a coin, and `$500 CAD to COP`
 * converts an amount at the live rate. Every render carries the change against
 * the previous close, because a quote without its reference point isn't a quote.
 *
 * This module is the runtime-agnostic core: pure parsing, alias resolution, the
 * change arithmetic, the markdown renderers, and the cache. It sits beside the
 * search engine and the dictionary as the third "engine" behind `/api/chat`.
 *
 * The one thing that makes this path different from the other two: the answer is
 * DATA, not generation. The route renders the provider payload deterministically,
 * so a quote runs no model, spends no Bedrock tokens, and writes no
 * `usage_events` row. The metered resource here is the provider call, which is
 * what the cache below exists to protect.
 */

// --- Parsing ---------------------------------------------------------------

/** A single instrument lookup: `$MDB`, `$BTC`, `$brk.b`. */
export interface SymbolQuery {
  kind: "symbol";
  /** As typed, uppercased. Alias resolution happens separately. */
  symbol: string;
}

/** An FX conversion: `$500 CAD to COP`. `amount` defaults to 1 for a bare rate. */
export interface ConvertQuery {
  kind: "convert";
  amount: number;
  from: string;
  to: string;
}

export type QuoteQuery = SymbolQuery | ConvertQuery;

// Ticker-plausible characters only. `.` for share classes (BRK.B) and exchange
// suffixes (XIC.TO), `-` for some ADRs, `&` because people type `$S&P`, `^` for
// raw index symbols, `/` for the pair form a provider uses (BTC/USD).
const SYMBOL_CHARS = /^[A-Z0-9.&^/-]+$/;
// Long enough for `XIC.TO` and `BTC/USD`, short enough that a stray word isn't
// mistaken for an instrument.
const MAX_SYMBOL_LENGTH = 12;

/**
 * ISO-4217 codes we accept in a conversion. Deliberately a static set: it is
 * what distinguishes `$500 CAD to COP` (a conversion) from `$MDB` (a symbol)
 * without asking the provider, so the parse stays pure and free. Covers the
 * majors plus the LATAM currencies this app actually gets asked about.
 */
const CURRENCIES = new Set([
  "USD", "EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD", "CNY", "HKD",
  "SGD", "SEK", "NOK", "DKK", "PLN", "CZK", "HUF", "TRY", "ZAR", "INR",
  "KRW", "TWD", "THB", "PHP", "IDR", "MYR", "ILS", "AED", "SAR",
  "MXN", "BRL", "COP", "ARS", "CLP", "PEN", "UYU", "BOB", "PYG", "CRC",
  "GTQ", "HNL", "NIO", "PAB", "DOP", "CUP", "VES",
]);

/** True when a token is a currency code we can convert. */
export function isCurrencyCode(token: string): boolean {
  return CURRENCIES.has(token.toUpperCase());
}

// `500`, `1,500.25`, `1.5k`, `2m`. The suffix is a convenience people actually
// type; anything else falls through and the input is not a conversion.
const AMOUNT = /^([0-9]+(?:,[0-9]{3})*(?:\.[0-9]+)?)([km])?$/i;

function parseAmount(token: string): number | null {
  const match = AMOUNT.exec(token);
  if (!match) return null;
  const digits = match[1]?.replace(/,/g, "");
  if (digits === undefined) return null;
  const base = Number(digits);
  if (!Number.isFinite(base) || base <= 0) return null;
  const suffix = match[2]?.toLowerCase();
  if (suffix === "k") return base * 1_000;
  if (suffix === "m") return base * 1_000_000;
  return base;
}

/**
 * Recognize a quote query: a single leading ASCII `$` followed by either an
 * instrument or a conversion. Returns null when the input is not a quote, and
 * the caller falls through to a normal chat turn — so `$` never becomes a
 * cheaper back door into a chat turn, and a sentence that merely mentions a
 * dollar amount is untouched.
 *
 * Not quotes: a bare `$`, `$$` (or any repeated leading `$`), a `$` followed by
 * a sentence, and a `$`-prefixed token that isn't ticker-shaped.
 */
export function parseQuoteQuery(raw: string): QuoteQuery | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("$") || trimmed.startsWith("$$")) return null;

  const rest = trimmed.slice(1).trim();
  if (rest.length === 0) return null;

  const tokens = rest.split(/\s+/);

  // Conversion, with or without a leading amount:
  //   "500 CAD to COP" | "CAD to COP" | "20 EUR in JPY"
  const converted = parseConversion(tokens);
  if (converted) return converted;

  // Instrument: exactly one ticker-shaped token.
  if (tokens.length !== 1) return null;
  const symbol = (tokens[0] ?? "").toUpperCase();
  if (symbol.length > MAX_SYMBOL_LENGTH) return null;
  if (!SYMBOL_CHARS.test(symbol)) return null;
  // A lone currency code is a rate request against USD, not an instrument.
  if (isCurrencyCode(symbol)) {
    return { kind: "convert", amount: 1, from: symbol, to: "USD" };
  }
  return { kind: "symbol", symbol };
}

/** `[amount?] FROM (to|in) TO`, or null when the tokens aren't that shape. */
function parseConversion(tokens: string[]): ConvertQuery | null {
  // Locate the separator; without one there is no conversion to read.
  const sepIndex = tokens.findIndex(
    (t) => t.toLowerCase() === "to" || t.toLowerCase() === "in",
  );
  if (sepIndex === -1) return null;

  const left = tokens.slice(0, sepIndex);
  const right = tokens.slice(sepIndex + 1);
  // Exactly one target currency after the separator.
  if (right.length !== 1) return null;
  const to = (right[0] ?? "").toUpperCase();
  if (!isCurrencyCode(to)) return null;

  // The source side is either "CAD" or "500 CAD".
  if (left.length === 0 || left.length > 2) return null;
  const from = (left[left.length - 1] ?? "").toUpperCase();
  if (!isCurrencyCode(from)) return null;

  // A missing amount reads as 1, which is the bare-rate question.
  let amount = 1;
  if (left.length === 2) {
    const parsed = parseAmount(left[0] ?? "");
    if (parsed === null) return null;
    amount = parsed;
  }

  return { kind: "convert", amount, from, to };
}

// --- Symbol resolution -----------------------------------------------------

export interface ResolvedSymbol {
  /** What we actually ask the provider for. */
  provider: string;
  /**
   * Set when the resolved symbol is a STAND-IN for what the user asked about —
   * an ETF tracking an index. Real index feeds are a paid entitlement on the
   * free tier, so `$S&P` quotes SPY; the render says so out loud rather than
   * passing an ETF off as the index.
   */
  proxyFor?: string;
  /** True for a crypto or FX pair, where no session close exists. */
  continuous: boolean;
}

/** A pair (`BTC/USD`, `XAU/USD`) trades continuously — no market close. */
function isPair(symbol: string): boolean {
  return symbol.includes("/");
}

/**
 * Map what people type to what the provider expects, and record whether the
 * result is a proxy. An unknown symbol passes through untouched — the provider
 * is the authority on whether `MDB` exists, not this table.
 */
export function resolveSymbol(symbol: string): ResolvedSymbol {
  const upper = symbol.toUpperCase();
  const alias = QUOTE_ALIASES[upper];
  if (alias) {
    return {
      provider: alias.provider,
      ...(alias.proxyFor === undefined ? {} : { proxyFor: alias.proxyFor }),
      continuous: isPair(alias.provider),
    };
  }
  return { provider: upper, continuous: isPair(upper) };
}

// --- Change arithmetic -----------------------------------------------------

/**
 * Which reference point the change is measured against. Equities, ETFs and index
 * proxies have a real session close; FX and crypto don't, so they compare to the
 * value 24 hours prior and the render says which window it used.
 */
export type ChangeWindow = "previous_close" | "24h";

export interface QuoteChange {
  absolute: number;
  percent: number;
  direction: "up" | "down" | "flat";
  window: ChangeWindow;
}

/**
 * Compute the change from the two raw numbers. Deliberately ours rather than
 * read off a provider field: it is the one piece of arithmetic every render
 * depends on, so it is computed in one place and unit-tested.
 *
 * A zero or missing reference yields null (no comparison) instead of an infinite
 * percentage.
 */
export function resolveChange(
  current: number,
  reference: number | null | undefined,
  window: ChangeWindow,
): QuoteChange | null {
  if (reference === null || reference === undefined) return null;
  if (!Number.isFinite(reference) || reference === 0) return null;
  if (!Number.isFinite(current)) return null;

  const absolute = current - reference;
  const percent = (absolute / reference) * 100;
  // An exact tie is rare on a real quote but trivially possible on a closed
  // market, where current IS the previous close.
  const direction = absolute > 0 ? "up" : absolute < 0 ? "down" : "flat";
  return { absolute, percent, direction, window };
}

// --- Rendering -------------------------------------------------------------

const NOT_ADVICE = "*Market data, not investment advice.*";

const WINDOW_LABEL: Record<ChangeWindow, string> = {
  previous_close: "vs. previous close",
  "24h": "vs. 24h ago",
};

const ARROW: Record<QuoteChange["direction"], string> = {
  up: "▲",
  down: "▼",
  flat: "=",
};

/** Money-ish formatting: thousands separators, 2 decimals for normal magnitudes,
 * more for the sub-cent rates an FX pair like COP produces. */
function formatNumber(value: number): string {
  const abs = Math.abs(value);
  const decimals = abs >= 1 ? 2 : abs >= 0.01 ? 4 : 6;
  return value.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** The one-line change fragment, or a plain note when there's no reference. */
function formatChange(change: QuoteChange | null): string {
  if (!change) return "_No comparison available._";
  const sign = change.absolute > 0 ? "+" : change.absolute < 0 ? "−" : "";
  return `${ARROW[change.direction]} ${sign}${formatNumber(Math.abs(change.absolute))} (${sign}${Math.abs(change.percent).toFixed(2)}%) ${WINDOW_LABEL[change.window]}`;
}

/** ISO timestamp rendered readably with its zone, so "as of" is unambiguous. */
function formatAsOf(asOf: Date): string {
  return `${asOf.toISOString().replace("T", " ").slice(0, 19)} UTC`;
}

export interface QuoteRender {
  /** What the user asked for, as typed (uppercased). */
  requested: string;
  resolved: ResolvedSymbol;
  name?: string;
  currency?: string;
  price: number;
  change: QuoteChange | null;
  marketOpen: boolean;
  asOf: Date;
}

/** The deterministic markdown block for an instrument quote. No model involved. */
export function renderQuote(q: QuoteRender): string {
  const heading = q.name
    ? `**${q.resolved.provider}** — ${q.name}`
    : `**${q.resolved.provider}**`;
  const currency = q.currency ? ` ${q.currency}` : "";

  const lines = [
    heading,
    "",
    `## ${formatNumber(q.price)}${currency}`,
    "",
    formatChange(q.change),
    "",
    `${q.marketOpen ? "Market open" : "Market closed"} · as of ${formatAsOf(q.asOf)}`,
  ];

  // Say the proxy out loud. Quietly answering `$S&P` with an ETF's price would
  // be a wrong answer dressed as a right one.
  if (q.resolved.proxyFor) {
    lines.push(
      "",
      `> \`${q.requested}\` is quoted using **${q.resolved.provider}**, an ETF that tracks ${q.resolved.proxyFor}. It is a close proxy, not the index itself.`,
    );
  }

  lines.push("", NOT_ADVICE);
  return lines.join("\n");
}

export interface ConversionRender {
  amount: number;
  from: string;
  to: string;
  rate: number;
  change: QuoteChange | null;
  asOf: Date;
}

/** The deterministic markdown block for an FX conversion. */
export function renderConversion(c: ConversionRender): string {
  const converted = c.amount * c.rate;
  return [
    `**${formatNumber(c.amount)} ${c.from}** → **${c.to}**`,
    "",
    `## ${formatNumber(converted)} ${c.to}`,
    "",
    `Rate: 1 ${c.from} = ${formatNumber(c.rate)} ${c.to}`,
    "",
    formatChange(c.change),
    "",
    `as of ${formatAsOf(c.asOf)}`,
    "",
    NOT_ADVICE,
  ].join("\n");
}

// --- Cache -----------------------------------------------------------------
//
// GLOBAL and CONTENT-ONLY, exactly like the Phase 8 search cache and the Phase
// 10 dictionary cache: the key is a hash of the resolved symbol or currency
// pair, the value is public market data, and neither carries a `userId` or any
// user-specific content. Two members quoting MDB share the entry (invariant #1
// holds because there is nothing user-owned to guard).
//
// The interesting part is the TTL, which is session-aware. A quote from an OPEN
// market is stale in seconds. A quote from a CLOSED market cannot change at all
// until the session reopens, so an evening of `$MDB` should cost one provider
// call, not one per question. That split is what keeps a free provider tier
// viable for a chat app where the same few tickers get asked repeatedly.

/** Open market: a price is stale almost immediately. */
export const QUOTE_TTL_OPEN_SECONDS = 60;
/**
 * Closed market: the price is frozen until the next session, so this could in
 * principle run for hours. It is a flat 30 minutes instead of "until the next
 * open" on purpose — computing the next open needs an exchange calendar with
 * holidays and early closes, and getting that wrong means serving a stale quote
 * into a live session. 30 minutes captures most of the saving with no calendar
 * to be wrong about.
 */
export const QUOTE_TTL_CLOSED_SECONDS = 30 * 60;

/** Pick the lifetime for an entry from the market's own open/closed state. */
export function quoteTtlSeconds(marketOpen: boolean): number {
  return marketOpen ? QUOTE_TTL_OPEN_SECONDS : QUOTE_TTL_CLOSED_SECONDS;
}

/**
 * What we store is the provider's DATA, not the rendered markdown — see
 * `QuoteValueSchema`, which is the single type source. This is the one place the
 * quote cache has to differ from the dictionary cache, which stores its finished
 * entry: a conversion's rate is independent of the amount asked about, so
 * `$500 CAD to COP` and `$20 CAD to COP` must share one cached rate and one
 * provider call. Caching the rendered block would key the amount into the value
 * and turn every new amount into a fresh API call.
 */
export type { QuoteValue };

export interface QuoteCacheStore {
  get(key: string): Promise<QuoteValue | null>;
  set(key: string, value: QuoteValue, ttlSeconds: number): Promise<void>;
}

/**
 * The cache key: a stable SHA-256 over the canonical subject of the quote — the
 * resolved provider symbol, or the currency pair. The AMOUNT is deliberately not
 * part of the key: `$500 CAD to COP` and `$20 CAD to COP` share one rate, so
 * they must share one provider call. (The route re-renders with the amount, so
 * a conversion is cached at the rate level, not the rendered level — see
 * conversionCacheKey's callers.)
 */
export function quoteCacheKey(providerSymbol: string): string {
  const canonical = JSON.stringify({ s: providerSymbol.toUpperCase() });
  return createHash("sha256").update(canonical).digest("hex");
}

/** The cache key for an FX pair, amount-independent for the reason above. */
export function conversionCacheKey(from: string, to: string): string {
  const canonical = JSON.stringify({
    f: from.toUpperCase(),
    t: to.toUpperCase(),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/** In-process L1: a bounded Map with per-entry expiry checked on read. */
export class MemoryQuoteCacheStore implements QuoteCacheStore {
  private readonly map = new Map<
    string,
    { value: QuoteValue; expiresAtMs: number }
  >();

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly maxEntries = 500,
  ) {}

  async get(key: string): Promise<QuoteValue | null> {
    const hit = this.map.get(key);
    if (!hit) return null;
    if (hit.expiresAtMs <= this.now()) {
      this.map.delete(key);
      return null;
    }
    return hit.value;
  }

  async set(key: string, value: QuoteValue, ttlSeconds: number): Promise<void> {
    if (ttlSeconds <= 0) return;
    if (this.map.size >= this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, { value, expiresAtMs: this.now() + ttlSeconds * 1000 });
  }
}

/**
 * MongoDB-backed L2. Reads honor `expiresAt` in the query (belt-and-suspenders
 * against the TTL monitor's lag), which matters more here than anywhere else:
 * serving a quote the reaper hasn't got to yet means showing a stale price.
 */
export class MongoQuoteCacheStore implements QuoteCacheStore {
  constructor(private readonly now: () => number = () => Date.now()) {}

  async get(key: string): Promise<QuoteValue | null> {
    const col = await quoteCacheCol();
    const doc = await col.findOne({
      _id: key,
      expiresAt: { $gt: new Date(this.now()) },
    });
    if (!doc) return null;
    return doc.value;
  }

  async set(key: string, value: QuoteValue, ttlSeconds: number): Promise<void> {
    if (ttlSeconds <= 0) return;
    const col = await quoteCacheCol();
    const entry: QuoteCacheEntry = {
      _id: key,
      value,
      createdAt: new Date(this.now()),
      expiresAt: new Date(this.now() + ttlSeconds * 1000),
    };
    const { _id, ...rest } = entry;
    await col.updateOne({ _id }, { $set: rest }, { upsert: true });
  }
}

/**
 * Two-tier read-through store: L1 (memory) in front of L2 (Mongo).
 *
 * Unlike the dictionary's tiered store, an L2 hit re-warms L1 with the SHORT
 * open-market TTL rather than a 5-minute default. An entry's true remaining life
 * can be as little as a few seconds here, and L1 does not re-check expiry
 * against a stored date, so the conservative refill is what stops a hot ticker
 * from pinning a stale price in memory.
 */
export class TieredQuoteCacheStore implements QuoteCacheStore {
  constructor(
    private readonly l1: QuoteCacheStore,
    private readonly l2: QuoteCacheStore,
  ) {}

  async get(key: string): Promise<QuoteValue | null> {
    const fromL1 = await this.l1.get(key);
    if (fromL1) return fromL1;
    const fromL2 = await this.l2.get(key);
    if (fromL2) {
      await this.l1.set(key, fromL2, QUOTE_TTL_OPEN_SECONDS);
      return fromL2;
    }
    return null;
  }

  async set(key: string, value: QuoteValue, ttlSeconds: number): Promise<void> {
    await Promise.all([
      this.l1.set(key, value, ttlSeconds),
      this.l2.set(key, value, ttlSeconds),
    ]);
  }
}

/** The process-wide default store: memory L1 + Mongo L2. Constructed once. */
let defaultStore: QuoteCacheStore | null = null;
export function getDefaultQuoteCacheStore(): QuoteCacheStore {
  defaultStore ??= new TieredQuoteCacheStore(
    new MemoryQuoteCacheStore(),
    new MongoQuoteCacheStore(),
  );
  return defaultStore;
}
