import { classifyIntent, resolveBang, type SearchSettings } from "@claudius/shared";

/**
 * The pre-graph router (Phase 8). Runs on the raw user text BEFORE the LangGraph
 * graph starts, so the two zero-cost paths — a DuckDuckGo-style bang and a bare
 * URL/domain — redirect the browser with NO Bedrock call and NO usage_events row
 * (the model never runs). Everything else returns null and falls through to the
 * normal chat turn.
 *
 * This is the first of the two-layer routing design: the pre-graph interceptor
 * catches the zero-LLM paths here; the in-tool source selection (Phase 7) still
 * controls cost once the model has itself chosen to search. A bang can't be
 * caught in the tool because the tool only runs inside the model loop — by then
 * the tokens are already spent.
 *
 * We only redirect when we can produce a CONCRETE url. A bang resolves to one; a
 * bare domain/URL is one. A "go to X" verb phrase classifies as navigational but
 * has no concrete target without a lookup we don't do, so it falls through to a
 * normal answer rather than guessing a URL.
 */

export interface RedirectResolution {
  url: string;
  /** A short, honest label for the inline thread record ("via !gh", "opened"). */
  label: string;
}

/** Normalize a bare domain/URL to an absolute https URL the browser can open. */
function toAbsoluteUrl(raw: string): string {
  const trimmed = raw.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

export function resolveRedirect(
  text: string,
  settings: SearchSettings,
): RedirectResolution | null {
  // (1) Bang → the site's own search. Highest-confidence, resolves to a URL.
  const bang = resolveBang(text, settings.customBangs);
  if (bang) {
    return { url: bang.url, label: `via !${bang.token}` };
  }

  // (2) Bare domain / URL classified navigational → open it directly.
  const { intent, reason } = classifyIntent(text, {
    ...(settings.customBangs ? { customBangs: settings.customBangs } : {}),
    settings,
  });
  if (intent === "navigational" && reason === "url_like") {
    return { url: toAbsoluteUrl(text), label: "opened" };
  }

  // Everything else falls through to the normal chat turn.
  return null;
}
