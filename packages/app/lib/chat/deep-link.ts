/**
 * Sanitizes an incoming `?q=` deep-link query before it becomes the first
 * message of a new conversation (see specs/phase-9-android.md). The value
 * arrives from a home-screen widget or an external link, so treat it as
 * untrusted plain text: trim surrounding whitespace, strip control characters,
 * and cap the length. It is NOT HTML and is never rendered as such; it flows
 * through the exact same send path as a typed message, so tier enforcement,
 * usage_events, and userId scoping all still apply downstream.
 */
export const MAX_DEEP_LINK_QUERY_LENGTH = 2000;

// C0/C1 control characters, keeping tab (\x09) and newline (\x0A) which are
// legitimate in a multi-line prompt. A URL could otherwise smuggle in NULs or
// escape sequences.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x08\x0B-\x1F\x7F-\x9F]/g;

export function sanitizeDeepLinkQuery(raw: string | undefined): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.replace(CONTROL_CHARS, "").trim();
  if (cleaned.length === 0) return null;
  return cleaned.slice(0, MAX_DEEP_LINK_QUERY_LENGTH);
}
