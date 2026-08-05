import { tavily } from "@tavily/core";
import { env } from "../../../env";

/**
 * The one Tavily-extract implementation in the tree (Phase 11).
 *
 * Extraction — "fetch and read the readable text of a page" — used to live only
 * in the research worker (`worker/src/research/tavily.ts`). Phase 11's read_url
 * tool needs the same capability on the request path, so the extract call is
 * lifted here into `@claudius/shared` and the worker now delegates to it. There
 * is exactly one place that calls Tavily's `extract`, shared by the chat agent
 * and the worker, so the fetch/read behavior and its truncation budget can't
 * drift between the two runtimes.
 *
 * Note the SSRF property this gives read_url for free: OUR server never connects
 * to the arbitrary URL — Tavily's servers do — so a private IP or the cloud
 * metadata endpoint is unreachable through us regardless of what the user pastes.
 */

let client: ReturnType<typeof tavily> | null = null;
function getClient(): ReturnType<typeof tavily> {
  client ??= tavily({ apiKey: env.TAVILY_API_KEY });
  return client;
}

/** Per-page character cap so one long page can't blow a token budget. */
export const MAX_PAGE_CHARS = 12_000;

export interface ExtractedPage {
  url: string;
  /** Best-effort page title; Tavily's extract may not return one (then ""). */
  title: string;
  /** The extracted readable text, truncated to MAX_PAGE_CHARS. */
  text: string;
}

/**
 * Fetch and extract the readable text of one or more pages via Tavily. Tavily
 * returns a `rawContent` string per successful URL; failures are dropped
 * silently (a dead link should never fail the whole caller). The client's field
 * naming has varied across versions, so we read both camel and snake case
 * defensively, and title if a version supplies it.
 */
export async function extractPages(urls: string[]): Promise<ExtractedPage[]> {
  if (urls.length === 0) return [];
  const response = await getClient().extract(urls, {});
  const results = (response.results ?? []) as Array<{
    url: string;
    title?: string;
    rawContent?: string;
    raw_content?: string;
  }>;
  return results
    .map((r) => ({
      url: r.url,
      title: typeof r.title === "string" ? r.title : "",
      text: (r.rawContent ?? r.raw_content ?? "").slice(0, MAX_PAGE_CHARS),
    }))
    .filter((p) => p.text.length > 0);
}

/**
 * Read one page's readable text. Returns null when the page yields nothing
 * (blocked, empty, or extract failed), so the caller can report a clean miss
 * rather than pretend it read something.
 */
export async function extractReadable(
  url: string,
): Promise<{ title: string; text: string } | null> {
  const [page] = await extractPages([url]);
  if (!page) return null;
  return { title: page.title, text: page.text };
}
