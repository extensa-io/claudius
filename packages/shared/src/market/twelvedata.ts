import { z } from "zod";
import { env } from "../env";

/**
 * Twelve Data client — the market-data backend for quote mode (Phase 13).
 *
 * Chosen because one symbol namespace covers equities, ETFs, FX pairs and crypto
 * (so `$MDB`, `$SPY`, `$BTC` and `$CAD to COP` are one code path, not four),
 * `/quote` returns `previous_close` and `is_market_open` in the same payload we
 * already need, and the free tier is 800 calls/day — enough for a personal app
 * behind the session-aware cache, where Alpha Vantage's 25/day would not be.
 *
 * Every response is parsed through Zod at the boundary, and every failure is a
 * TYPED outcome rather than a thrown surprise, because the caller has to render
 * different things for "that ticker doesn't exist", "we're rate limited" and "the
 * provider is down" — and must never render a number it didn't get.
 */

const ENDPOINT = "https://api.twelvedata.com";
const REQUEST_TIMEOUT_MS = 6000;

/** Why a market-data call failed. The route maps each to a user-safe sentence. */
export type MarketFailureReason =
  /** No API key configured — quote mode is simply off in this deployment. */
  | "not_configured"
  /** The provider does not know this symbol (or the plan can't see it). */
  | "unknown_symbol"
  /** Free-tier limit hit (429, or the API's in-body credit message). */
  | "rate_limited"
  /** Timeout, non-2xx, or a body that didn't match the schema. */
  | "provider_error";

export interface MarketFailure {
  ok: false;
  reason: MarketFailureReason;
}

export interface MarketSuccess<T> {
  ok: true;
  data: T;
}

export type MarketResult<T> = MarketSuccess<T> | MarketFailure;

/** One instrument's current state, normalized off `/quote`. */
export interface InstrumentQuote {
  symbol: string;
  name?: string;
  currency?: string;
  price: number;
  /** The session's previous close; null when the provider omitted it. */
  previousClose: number | null;
  marketOpen: boolean;
  asOf: Date;
}

/** An FX pair's current rate, plus the 24h-ago rate when we could get one. */
export interface ExchangeRate {
  from: string;
  to: string;
  rate: number;
  /** The rate ~24h earlier; null when the history call failed or was empty. */
  reference: number | null;
  asOf: Date;
}

// Twelve Data returns numbers as strings, and signals in-body errors with
// `status: "error"` and a `code` even on a 200, so both shapes are modeled.
const ErrorBodySchema = z.object({
  status: z.literal("error"),
  code: z.number().optional(),
  message: z.string().optional(),
});

const QuoteBodySchema = z.object({
  symbol: z.string(),
  name: z.string().optional(),
  currency: z.string().optional(),
  close: z.string(),
  previous_close: z.string().optional(),
  is_market_open: z.boolean().optional(),
  datetime: z.string().optional(),
  timestamp: z.number().optional(),
});

const ExchangeRateBodySchema = z.object({
  symbol: z.string(),
  rate: z.number(),
  timestamp: z.number().optional(),
});

const TimeSeriesBodySchema = z.object({
  values: z.array(z.object({ datetime: z.string(), close: z.string() })).min(1),
});

/** Parse a provider numeric string; null when it isn't a usable number. */
function toNumber(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function fail(reason: MarketFailureReason): MarketFailure {
  return { ok: false, reason };
}

/**
 * One GET against Twelve Data, returning the parsed JSON body or a typed
 * failure. Rate-limit and unknown-symbol signals arrive both as HTTP statuses
 * and as in-body error objects on a 200, so both are classified here in one
 * place rather than at each call site.
 */
async function request(
  path: string,
  params: Record<string, string>,
): Promise<MarketResult<unknown>> {
  const apiKey = env.TWELVEDATA_API_KEY;
  if (apiKey === undefined) return fail("not_configured");

  const url = new URL(`${ENDPOINT}${path}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  url.searchParams.set("apikey", apiKey);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, { method: "GET", signal: controller.signal });
  } catch (error) {
    // Never log the URL: it carries the API key in a query param.
    console.error(
      "Twelve Data request failed:",
      error instanceof Error ? `${error.name}: ${error.message}` : "unknown",
    );
    return fail("provider_error");
  } finally {
    clearTimeout(timeout);
  }

  if (response.status === 429) return fail("rate_limited");
  if (response.status === 404) return fail("unknown_symbol");
  if (!response.ok) {
    console.error(`Twelve Data returned HTTP ${response.status}`);
    return fail("provider_error");
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return fail("provider_error");
  }

  // An in-body error on a 200. 404 = symbol not found, 429 = credits exhausted.
  const asError = ErrorBodySchema.safeParse(body);
  if (asError.success) {
    const code = asError.data.code;
    if (code === 404 || code === 400) return fail("unknown_symbol");
    if (code === 429) return fail("rate_limited");
    console.error(`Twelve Data error body (code ${code ?? "none"})`);
    return fail("provider_error");
  }

  return { ok: true, data: body };
}

/** The provider's `datetime`/`timestamp`, or now when it gave neither. */
function resolveAsOf(datetime?: string, timestamp?: number): Date {
  if (timestamp !== undefined) return new Date(timestamp * 1000);
  if (datetime !== undefined) {
    const parsed = new Date(datetime.includes(" ") ? `${datetime}Z` : datetime);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
}

/** Fetch one instrument quote (equity, ETF, index proxy, or crypto pair). */
export async function fetchQuote(
  symbol: string,
): Promise<MarketResult<InstrumentQuote>> {
  const result = await request("/quote", { symbol });
  if (!result.ok) return result;

  const parsed = QuoteBodySchema.safeParse(result.data);
  if (!parsed.success) return fail("provider_error");

  const price = toNumber(parsed.data.close);
  // A body that parsed but carries no usable price is a provider problem, not a
  // quote: rendering it would mean showing a blank where a number belongs.
  if (price === null) return fail("provider_error");

  return {
    ok: true,
    data: {
      symbol: parsed.data.symbol,
      ...(parsed.data.name === undefined ? {} : { name: parsed.data.name }),
      ...(parsed.data.currency === undefined
        ? {}
        : { currency: parsed.data.currency }),
      price,
      previousClose: toNumber(parsed.data.previous_close),
      // Absent for a 24/7 pair; those markets never close, so default to open.
      marketOpen: parsed.data.is_market_open ?? true,
      asOf: resolveAsOf(parsed.data.datetime, parsed.data.timestamp),
    },
  };
}

/**
 * Fetch an FX pair's live rate, plus the rate ~24h ago as the reference point.
 *
 * FX has no session close, so the comparison window is 24 hours (the decision
 * recorded in resolveChange's ChangeWindow). The history call is best-effort: if
 * it fails we still return the live rate with a null reference and the render
 * simply omits the comparison, rather than failing the whole quote over the
 * nice-to-have half of it.
 */
export async function fetchExchangeRate(
  from: string,
  to: string,
): Promise<MarketResult<ExchangeRate>> {
  const pair = `${from}/${to}`;
  const result = await request("/exchange_rate", { symbol: pair });
  if (!result.ok) return result;

  const parsed = ExchangeRateBodySchema.safeParse(result.data);
  if (!parsed.success) return fail("provider_error");

  return {
    ok: true,
    data: {
      from,
      to,
      rate: parsed.data.rate,
      reference: await fetchDayAgoClose(pair),
      asOf: resolveAsOf(undefined, parsed.data.timestamp),
    },
  };
}

/**
 * The close ~24h before now for a pair, via one daily-interval history point.
 * Returns null on any failure — see fetchExchangeRate for why that is deliberate
 * rather than propagated.
 */
export async function fetchDayAgoClose(symbol: string): Promise<number | null> {
  const result = await request("/time_series", {
    symbol,
    interval: "1day",
    // Two points: the current (partial) day and the one before it. The previous
    // day's close is the 24h reference.
    outputsize: "2",
  });
  if (!result.ok) return null;

  const parsed = TimeSeriesBodySchema.safeParse(result.data);
  if (!parsed.success) return null;

  // Twelve Data returns newest-first, so index 1 is the prior day.
  const prior = parsed.data.values[1] ?? parsed.data.values[0];
  return toNumber(prior?.close);
}

/** Whether quote mode is configured at all. Lets the route answer without a
 * round trip when the deployment has no key. */
export function isMarketDataConfigured(): boolean {
  return env.TWELVEDATA_API_KEY !== undefined;
}
