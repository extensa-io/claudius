import { describe, expect, it } from "vitest";
import {
  MAX_DEEP_LINK_QUERY_LENGTH,
  sanitizeDeepLinkQuery,
} from "./deep-link";

describe("sanitizeDeepLinkQuery", () => {
  it("returns null for undefined, empty, or whitespace-only input", () => {
    expect(sanitizeDeepLinkQuery(undefined)).toBeNull();
    expect(sanitizeDeepLinkQuery("")).toBeNull();
    expect(sanitizeDeepLinkQuery("   ")).toBeNull();
    expect(sanitizeDeepLinkQuery("\t\n  ")).toBeNull();
  });

  it("trims surrounding whitespace", () => {
    expect(sanitizeDeepLinkQuery("  hello world  ")).toBe("hello world");
  });

  it("preserves interior whitespace, tabs, and newlines", () => {
    expect(sanitizeDeepLinkQuery("line one\nline two")).toBe(
      "line one\nline two",
    );
    expect(sanitizeDeepLinkQuery("a\tb")).toBe("a\tb");
  });

  it("strips control characters a URL could smuggle in", () => {
    expect(sanitizeDeepLinkQuery("hel\x00lo\x07")).toBe("hello");
    expect(sanitizeDeepLinkQuery("a\x1Fb")).toBe("ab");
  });

  it("caps length at the maximum", () => {
    const long = "x".repeat(MAX_DEEP_LINK_QUERY_LENGTH + 500);
    const result = sanitizeDeepLinkQuery(long);
    expect(result).toHaveLength(MAX_DEEP_LINK_QUERY_LENGTH);
  });

  it("treats content as plain text, not HTML (no escaping, passed through)", () => {
    // It's a chat message, never rendered as HTML, so we don't mangle it.
    expect(sanitizeDeepLinkQuery("what is <div> in html?")).toBe(
      "what is <div> in html?",
    );
  });
});
