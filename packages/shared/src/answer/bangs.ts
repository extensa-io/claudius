import type { Bang } from "../db/schemas";
import { DEFAULT_BANGS } from "./defaults";

/**
 * Bang parsing (Phase 8): DuckDuckGo-style `!token` shortcuts that redirect a
 * query to a site's own search with zero tokens and zero API calls. This module
 * is pure (no I/O): the caller loads `customBangs` from settings and hands them
 * in, so the same function is testable in isolation and reusable off any runtime.
 *
 * Behavior, matching the spec:
 *   - A leading OR trailing `!token` is recognized (`!gh langgraph`, `langgraph
 *     !gh`). Case-insensitive on the token.
 *   - The token is looked up in the merged table (custom bangs OVER built-ins).
 *   - The remaining query is URL-encoded and substituted for `{query}`; a bang
 *     with no remaining query substitutes empty (the site's near-home search).
 *   - An UNKNOWN bang returns null — the caller falls through to normal search
 *     rather than erroring, so a stray `!` never breaks a real question.
 */

export interface BangResolution {
  /** The bang token that matched (without the leading `!`). */
  token: string;
  /** The fully resolved, ready-to-open URL. */
  url: string;
}

/** Merge custom bangs over the built-in table; a custom token wins on collision. */
export function mergeBangs(custom: Bang[] | undefined): Map<string, string> {
  const table = new Map<string, string>();
  for (const b of DEFAULT_BANGS) table.set(b.token.toLowerCase(), b.urlTemplate);
  for (const b of custom ?? []) table.set(b.token.toLowerCase(), b.urlTemplate);
  return table;
}

/** True if the raw input carries a leading or trailing `!token`. Cheap signal
 * the classifier reuses without resolving the URL. */
export function hasBang(raw: string): boolean {
  return extractBang(raw) !== null;
}

interface ExtractedBang {
  token: string;
  rest: string;
}

/**
 * Pull a leading or trailing `!token` out of the input, returning the token and
 * the remaining query. A bare `!` (no token chars) is not a bang. Only a single
 * bang is honored — the first structural one found (leading preferred).
 */
function extractBang(raw: string): ExtractedBang | null {
  const trimmed = raw.trim();
  if (!trimmed.includes("!")) return null;

  const tokens = trimmed.split(/\s+/);

  // Leading bang: "!gh some query"
  const first = tokens[0];
  if (first && first.startsWith("!") && first.length > 1) {
    return {
      token: first.slice(1).toLowerCase(),
      rest: tokens.slice(1).join(" "),
    };
  }

  // Trailing bang: "some query !gh"
  const last = tokens[tokens.length - 1];
  if (tokens.length > 1 && last && last.startsWith("!") && last.length > 1) {
    return {
      token: last.slice(1).toLowerCase(),
      rest: tokens.slice(0, -1).join(" "),
    };
  }

  return null;
}

/**
 * Resolve a bang in the raw input against the merged table. Returns the resolved
 * URL, or null when there is no bang OR the bang is unknown (caller falls through
 * to normal search).
 */
export function resolveBang(
  raw: string,
  customBangs?: Bang[],
): BangResolution | null {
  const extracted = extractBang(raw);
  if (!extracted) return null;

  const table = mergeBangs(customBangs);
  const template = table.get(extracted.token);
  if (!template) return null; // unknown bang → fall through to normal search

  // encodeURIComponent so a multi-word query is a single safe path/param value.
  // A no-query bang substitutes empty; most templates then land on a near-home
  // search page, which is the expected "just take me there" behavior.
  const url = template.replace("{query}", encodeURIComponent(extracted.rest));
  return { token: extracted.token, url };
}
