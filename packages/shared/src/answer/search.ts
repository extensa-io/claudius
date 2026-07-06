import { AppError } from "../errors";
import {
  braveCountThisMonth,
  loadSearchSettings,
  recordBraveCall,
} from "../tiers/catalog";
import { braveSearch, BraveSearchError } from "./brave";
import { tavilySearch } from "./tavily";
import type {
  AnswerSearchRequest,
  AnswerSearchResult,
  SearchResult,
  SelectionReason,
} from "./types";

/**
 * Source selection — the heart of the cost-tiered answer engine (Phase 7).
 *
 * The rule this phase is deliberately simple and documented, with the interface
 * shaped so Phase 8's intent router can drive the high-value gate later:
 *
 *   1. High-value gate: if the caller marks the request `highValue`, go straight
 *      to Tavily (advanced depth) — clean extraction and reranking are worth the
 *      cost for these.
 *   2. Otherwise Brave is the default WHILE under the free monthly threshold.
 *   3. Fall back to Tavily when:
 *        - the Brave monthly allowance is exhausted (quota),
 *        - Brave errors or times out (reliability),
 *        - Brave returns too few usable results (quality gate).
 *   4. If BOTH backends are unavailable, surface one user-safe AppError — never
 *      a hang, never a leaked internal.
 *
 * The chosen `source` and `reason` are returned for server-side logging so the
 * acceptance criterion ("Tavily fires only as a fallback, verifiable in
 * logging") is checkable; the tool discards them and returns only `results`.
 */

function ok(
  results: SearchResult[],
  source: AnswerSearchResult["source"],
  reason: SelectionReason,
): AnswerSearchResult {
  return { results, source, reason };
}

/** Tavily fallback that turns a Tavily failure into a user-safe AppError. */
async function tavilyOrFail(
  query: string,
  maxResults: number | undefined,
  depth: "basic" | "advanced",
  reason: SelectionReason,
): Promise<AnswerSearchResult> {
  try {
    const results = await tavilySearch(query, maxResults, depth);
    return ok(results, "tavily", reason);
  } catch {
    // Both backends are down (or the only-Tavily path failed). Do not leak the
    // underlying error; the tool maps this to a graceful "search unavailable".
    throw new AppError(
      "internal",
      "Web search is temporarily unavailable. Please try again.",
    );
  }
}

export async function answerSearch(
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

  // (2) Brave is the default. Count the call against the free-tier allowance
  // BEFORE issuing it: the counter is a spend guard, so an attempt should
  // consume quota even if it then errors (a failing call still hit Brave's
  // metered endpoint). A cache hit in Phase 8 will skip this path entirely.
  try {
    await recordBraveCall();
    const results = await braveSearch(query, maxResults);

    // (3c) Quality gate: too few usable results → retry on Tavily. Brave's
    // quota was already spent on the attempt; that's acceptable for a soft
    // guard, and Phase 8's cache softens the double-hit further.
    if (results.length < settings.highValueMinResults) {
      return tavilyOrFail(query, maxResults, "basic", "brave_low_quality");
    }
    return ok(results, "brave", "brave_primary");
  } catch (error: unknown) {
    // (3b) Brave errored or timed out → Tavily fallback.
    if (error instanceof BraveSearchError) {
      return tavilyOrFail(query, maxResults, "basic", "brave_error");
    }
    // recordBraveCall failing means settings are misconfigured — that is a real
    // internal fault, not a backend hiccup, so surface it rather than mask it.
    throw error;
  }
}
