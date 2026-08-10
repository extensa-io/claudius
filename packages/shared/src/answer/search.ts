import type { CacheTtls } from "../db/schemas";
import { AppError } from "../errors";
import {
  braveCountThisMonth,
  loadSearchSettings,
  recordBraveCall,
} from "../tiers/catalog";
import { braveSearch, BraveSearchError } from "./brave";
import type { CacheStore } from "./cache";
import { cacheKey, ttlForIntent } from "./cache";
import { isFresh } from "./classify";
import { tavilySearch } from "./tavily";
import type {
  AnswerSearchRequest,
  AnswerSearchResult,
  SearchIntent,
  SearchResult,
  SelectionReason,
} from "./types";

/**
 * Source selection — the heart of the cost-tiered answer engine (Phase 7),
 * extended in Phase 8 with a read-through cache and intent-aware TTLs.
 *
 * The cost model is unchanged and deliberate: ONE paid backend is consulted per
 * query. Brave is the default under its free monthly allowance; Tavily is the
 * fallback (quota/error/quality) and the high-value slot. We do NOT fan both
 * paid backends out concurrently on a query — that would double the cost the
 * tiering exists to avoid. Robustness instead comes from a per-source TIMEOUT so
 * a slow backend drops out and the fallback still returns results (the
 * "partial results within budget" acceptance criterion): Brave carries its own
 * abort timeout, and the Tavily fallback is wrapped in one here.
 *
 * Phase 8 additions, all inert for a Phase 7 caller (one that passes only
 * `query`, no `intent`, and no cache store):
 *   - a cache read-through: an identical query served from `search_cache` skips
 *     the backend round trip entirely (`cache_hit`). Only engaged when the caller
 *     injects a store, so the Phase 7 unit tests keep exercising raw selection.
 *   - intent-aware cache TTLs: navigational is never cached; informational picks
 *     fresh vs. evergreen; transactional gets the short churn TTL.
 *
 * The chosen `source`/`reason` are returned for server-side logging so the
 * routing is auditable; the tool discards them and returns only `results`.
 */

// The Tavily fallback has no internal timeout of its own, so bound it here. Brave
// already aborts at 6s; a matched ceiling keeps a slow fallback from eating the
// chat turn's budget. On timeout the source "drops out" and we surface the same
// user-safe unavailable error the both-down path uses.
const TAVILY_TIMEOUT_MS = 8000;

function ok(
  results: SearchResult[],
  source: AnswerSearchResult["source"],
  reason: SelectionReason,
): AnswerSearchResult {
  return { results, source, reason };
}

/** Run a source promise against a per-source timeout; a timeout rejects so the
 * caller treats it exactly like any other source failure (drops out). */
async function withTimeout<T>(
  work: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/** Tavily fallback that turns any Tavily failure (including a timeout) into a
 * user-safe AppError — both backends are effectively down for this query. */
async function tavilyOrFail(
  query: string,
  maxResults: number | undefined,
  depth: "basic" | "advanced",
  reason: SelectionReason,
): Promise<AnswerSearchResult> {
  try {
    const results = await withTimeout(
      tavilySearch(query, maxResults, depth),
      TAVILY_TIMEOUT_MS,
      "tavily",
    );
    return ok(results, "tavily", reason);
  } catch {
    // Do not leak the underlying error; the tool maps this to a graceful
    // "search unavailable" so the chat turn still completes.
    throw new AppError(
      "internal",
      "Web search is temporarily unavailable. Please try again.",
    );
  }
}

/**
 * The raw source-selection path (Phase 7 behavior). Kept separate from the cache
 * wrapper so its cost-tiered logic stays the single, testable unit it was.
 */
async function selectAndSearch(
  request: AnswerSearchRequest,
): Promise<AnswerSearchResult> {
  const { query, maxResults, highValue = false } = request;

  // (1) Explicit high-value depth signal → Tavily advanced, no Brave call.
  if (highValue) {
    return tavilyOrFail(query, maxResults, "advanced", "high_value_gate");
  }

  const settings = await loadSearchSettings();
  const used = braveCountThisMonth(settings.braveUsage);

  // (2/3a) Brave monthly allowance exhausted → Tavily fallback (basic depth).
  if (used >= settings.braveMonthlyThreshold) {
    return tavilyOrFail(query, maxResults, "basic", "brave_quota_exhausted");
  }

  // (2) Brave is the default. Count the call BEFORE issuing it: the counter is a
  // spend guard, so an attempt consumes quota even if it then errors.
  try {
    await recordBraveCall();
    const results = await braveSearch(query, maxResults);

    // (3c) Quality gate: too few usable results → retry on Tavily.
    if (results.length < settings.highValueMinResults) {
      return tavilyOrFail(query, maxResults, "basic", "brave_low_quality");
    }
    return ok(results, "brave", "brave_primary");
  } catch (error: unknown) {
    // (3b) Brave errored or timed out → Tavily fallback (partial results from
    // the source that responded — the timeout acceptance criterion).
    if (error instanceof BraveSearchError) {
      return tavilyOrFail(query, maxResults, "basic", "brave_error");
    }
    // recordBraveCall failing means settings are misconfigured — a real internal
    // fault, not a backend hiccup, so surface it rather than mask it.
    throw error;
  }
}

/**
 * The public entry point. `opts.cache` engages the Phase 8 read-through cache;
 * without it this is exactly the Phase 7 selection path (so the Phase 7 tests,
 * which inject no store, still test raw selection).
 *
 * The cache is GLOBAL and CONTENT-ONLY — the key hashes only the normalized
 * query + intent + source params, never a userId — so a hit is safely shared
 * across users (invariant #1 holds by construction; see cache.ts).
 */
export async function answerSearch(
  request: AnswerSearchRequest,
  opts: { cache?: CacheStore; cacheTtls?: CacheTtls } = {},
): Promise<AnswerSearchResult> {
  // A lexical (`?` dictionary) query is served by the dictionary path and a
  // market (`$` quote) query by the quote path; neither reaches the engine. If
  // one somehow arrives, treat it as informational so the search cache's
  // SearchIntent stays honest.
  const intent: SearchIntent =
    request.intent &&
    request.intent !== "lexical" &&
    request.intent !== "market"
      ? request.intent
      : "informational";
  const { cache } = opts;

  // Navigational queries never reach the engine in production (the pre-graph
  // interceptor resolves them to a URL). If one arrives anyway, we still serve
  // it as a normal search but never cache it.
  const cacheable = cache != null && intent !== "navigational";
  const key = cacheable
    ? cacheKey({
        query: request.query,
        intent,
        highValue: request.highValue ?? false,
        maxResults: request.maxResults,
      })
    : null;

  // (0) Cache read-through: an identical prior query skips both backends.
  if (cacheable && key) {
    const hit = await cache!.get(key);
    if (hit) {
      return ok(hit.results, hit.source, "cache_hit");
    }
  }

  const result = await selectAndSearch(request);

  // Populate the cache on a real backend result. TTL is intent-aware: a
  // news-like informational query reaps in minutes, an evergreen one survives
  // for weeks. A zero TTL (navigational) is a no-op in the store.
  if (cacheable && key && result.results.length > 0) {
    const ttl = ttlForIntent(intent, isFresh(request.query), opts.cacheTtls);
    await cache!.set(
      key,
      { results: result.results, source: result.source, intent },
      ttl,
    );
  }

  return result;
}
