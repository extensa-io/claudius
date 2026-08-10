import type { Bang, SearchSettings } from "../db/schemas";
import { hasBang } from "./bangs";
import { DEFAULT_ESCALATION_KEYWORDS } from "./defaults";
import { parseDefineQuery } from "./dictionary";
import { parseQuoteQuery } from "./quotes";
import type { Intent } from "./types";

/**
 * Intent classification (Phase 8): a heuristic, rules-first classifier that runs
 * BEFORE the model wakes up, so navigational queries can redirect for zero tokens
 * and the engine can pick a cache TTL and a backend by intent.
 *
 * It is deliberately cheap and explainable — explicit bang, URL/domain shape,
 * known navigational patterns — and defaults to `informational` (the common
 * case, "the user wants an answer"). The interface is a single pure function so
 * an LLM classifier can replace the body later WITHOUT changing any caller: the
 * seam the spec asks for. `reason` exists for logging, never for the model.
 */

export interface IntentResult {
  intent: Intent;
  /** A one-line, log-friendly explanation of which rule fired. */
  reason: string;
  /** For an informational query, whether a depth signal escalates to Tavily. */
  highValue: boolean;
}

// A bare domain or URL: "github.com", "https://x.com/foo", "www.bbc.co.uk".
// Requires a dot and a plausible TLD; kept strict so "node.js is great" (a
// sentence) isn't mistaken for navigation.
const URL_LIKE = /^(https?:\/\/)?([a-z0-9-]+\.)+[a-z]{2,}(\/\S*)?$/i;

// Leading verbs that signal the user wants to GO to a known site rather than
// read an answer. "open twitter", "go to gmail", "launch figma".
const NAVIGATIONAL_PREFIX = /^(open|go to|goto|launch|visit|navigate to)\s+\S+/i;

// Transactional intent: the user wants to DO/GET something, not read about it.
const TRANSACTIONAL = [
  "download",
  "buy",
  "cheapest",
  "price of",
  "coupon",
  "discount",
  "convert",
  "install",
  "sign up for",
  "order",
];

// News-like / time-sensitive terms → the classifier flags freshness so the
// cache layer can pick the short TTL. Not an intent of its own; informational
// with a `fresh` hint.
const FRESH_TERMS = [
  "today",
  "latest",
  "breaking",
  "right now",
  "current",
  "this week",
  "score",
  "stock price",
  "weather",
];

function escalationKeywords(settings?: SearchSettings): string[] {
  return settings?.escalationKeywords ?? DEFAULT_ESCALATION_KEYWORDS;
}

/** Whether an informational query carries a depth signal → Tavily advanced. */
export function isHighValue(query: string, settings?: SearchSettings): boolean {
  const q = query.toLowerCase();
  return escalationKeywords(settings).some((kw) => q.includes(kw.toLowerCase()));
}

/** Whether an informational query looks news-like / time-sensitive. Drives the
 * cache TTL (fresh vs. evergreen), NOT the backend choice. */
export function isFresh(query: string): boolean {
  const q = query.toLowerCase();
  return FRESH_TERMS.some((t) => q.includes(t));
}

/**
 * Classify a raw user query. `customBangs` (from settings) are consulted only to
 * know whether a bang is PRESENT — resolution happens in the interceptor. The
 * classifier stays pure and synchronous so it costs nothing on the hot path.
 */
export function classifyIntent(
  raw: string,
  opts: { customBangs?: Bang[]; settings?: SearchSettings } = {},
): IntentResult {
  const query = raw.trim();

  // (0) Explicit `?` define/translate operator → lexical (Phase 10). Checked
  //     first: `?` is unambiguous, and the dictionary path short-circuits the
  //     turn before the search engine ever runs.
  if (parseDefineQuery(query) !== null) {
    return { intent: "lexical", reason: "define_operator", highValue: false };
  }

  // (0.5) Explicit `$` quote operator → market (Phase 13). Beside the `?` rule
  //       and before bang for the same reason: `$` is unambiguous, and the quote
  //       path short-circuits the turn before the search engine ever runs.
  if (parseQuoteQuery(query) !== null) {
    return { intent: "market", reason: "quote_operator", highValue: false };
  }

  // (1) Explicit bang → navigational, highest-confidence signal.
  if (hasBang(query)) {
    return { intent: "navigational", reason: "bang", highValue: false };
  }

  // (2) URL-like or bare-domain input → navigational (the user wants to go there).
  //     Guard on a single token so a sentence containing a domain isn't caught.
  if (!/\s/.test(query) && URL_LIKE.test(query)) {
    return { intent: "navigational", reason: "url_like", highValue: false };
  }

  // (3) "open X" / "go to X" navigational verb prefix.
  if (NAVIGATIONAL_PREFIX.test(query)) {
    return { intent: "navigational", reason: "nav_prefix", highValue: false };
  }

  // (4) Transactional verbs → the user wants to do/get something.
  const lower = query.toLowerCase();
  if (TRANSACTIONAL.some((t) => lower.includes(t))) {
    return { intent: "transactional", reason: "transactional_verb", highValue: false };
  }

  // (5) Default: informational. Attach the depth signal so source selection can
  //     escalate to Tavily when the user clearly wants something thorough.
  return {
    intent: "informational",
    reason: "default_informational",
    highValue: isHighValue(query, opts.settings),
  };
}
