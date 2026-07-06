import { env } from "../env";
import type { SearchResult } from "./types";

/**
 * Brave Web Search client — the answer engine's primary backend (Phase 7).
 *
 * Brave runs its own independent index (not a Bing/Google reseller), offers a
 * free monthly query allowance, and is a plain HTTPS API with no SDK and no
 * ops, which keeps the engine in line with the rest of the serverless stack.
 * We map its hits to the canonical `{ title, url, snippet }` shape the tool and
 * UI already speak; Brave's `description` field is the snippet.
 *
 * Two safety properties matter here:
 *   - a per-request timeout via `AbortController`, so a slow Brave never hangs a
 *     chat turn (the engine falls back to Tavily on timeout);
 *   - respect for Brave's per-second rate limit on the free tier (1 req/s), via
 *     a tiny in-process spacing gate so a burst of turns can't 429 us.
 */

const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const DEFAULT_MAX_RESULTS = 5;
const REQUEST_TIMEOUT_MS = 6000;
// Brave's free tier allows 1 request/second. Space calls at least this far apart.
const MIN_REQUEST_SPACING_MS = 1100;

/** Raised on any non-success from Brave so selection can fall back cleanly. */
export class BraveSearchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BraveSearchError";
  }
}

// The shape we read off Brave's response. Brave returns far more, but the tool
// contract only needs these three fields per web result.
interface BraveWebResult {
  title?: string;
  url?: string;
  description?: string;
}
interface BraveResponse {
  web?: { results?: BraveWebResult[] };
}

// In-process spacing gate. Serializes Brave calls to at least
// MIN_REQUEST_SPACING_MS apart so the free tier's 1/s limit isn't tripped by
// concurrent chat turns in the same process. Best-effort (per-instance, not
// cross-instance), which is the right tradeoff for a soft rate limit.
let nextAllowedAt = 0;
async function waitForRateLimitSlot(): Promise<void> {
  const now = Date.now();
  const wait = Math.max(0, nextAllowedAt - now);
  nextAllowedAt = Math.max(now, nextAllowedAt) + MIN_REQUEST_SPACING_MS;
  if (wait > 0) {
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

/**
 * Run one Brave web search and return canonical hits. Throws `BraveSearchError`
 * on timeout, a non-2xx status, or a malformed body, so the caller (source
 * selection) can degrade to Tavily rather than surface an internal failure.
 */
export async function braveSearch(
  query: string,
  maxResults = DEFAULT_MAX_RESULTS,
): Promise<SearchResult[]> {
  await waitForRateLimitSlot();

  const url = new URL(BRAVE_ENDPOINT);
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(maxResults));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": env.BRAVE_API_KEY,
      },
      signal: controller.signal,
    });
  } catch (error: unknown) {
    // AbortError (timeout) and network failures both land here.
    const detail = error instanceof Error ? error.name : "unknown";
    throw new BraveSearchError(`Brave request failed (${detail}).`);
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new BraveSearchError(`Brave returned status ${response.status}.`);
  }

  let body: BraveResponse;
  try {
    body = (await response.json()) as BraveResponse;
  } catch {
    throw new BraveSearchError("Brave returned a malformed body.");
  }

  const hits = body.web?.results ?? [];
  return hits
    .filter((r): r is Required<Pick<BraveWebResult, "title" | "url">> &
      BraveWebResult => Boolean(r.title && r.url))
    .map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.description ?? "",
    }));
}
