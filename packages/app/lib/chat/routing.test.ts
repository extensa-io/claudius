import { describe, expect, it } from "vitest";
import type { SearchSettings } from "@claudius/shared";
import { resolveRedirect } from "./routing";

/**
 * The pre-graph router (Phase 8) — the decision that makes bang and navigational
 * queries a ZERO-COST path. This tests only the resolution logic (which inputs
 * produce a redirect URL); the route wiring that skips Bedrock/usage_events sits
 * on top of it. A redirect here means the interceptor returns before any model
 * call, so no usage_events row is written.
 */

function settings(overrides: Partial<SearchSettings> = {}): SearchSettings {
  return {
    _id: "search",
    braveMonthlyThreshold: 1000,
    braveUsage: { month: "2026-07", count: 0 },
    highValueMinResults: 3,
    ...overrides,
  };
}

describe("resolveRedirect", () => {
  it("resolves a bang to the site's search URL", () => {
    const r = resolveRedirect("!gh langgraph", settings());
    expect(r).not.toBeNull();
    expect(r!.url).toContain("github.com/search");
    expect(r!.label).toBe("via !gh");
  });

  it("resolves a bare domain to an absolute https URL", () => {
    const r = resolveRedirect("mongodb.com", settings());
    expect(r).not.toBeNull();
    expect(r!.url).toBe("https://mongodb.com");
    expect(r!.label).toBe("opened");
  });

  it("passes an absolute URL through unchanged", () => {
    const r = resolveRedirect("https://www.bbc.co.uk/news", settings());
    expect(r!.url).toBe("https://www.bbc.co.uk/news");
  });

  it("falls through (null) for a normal informational question", () => {
    // No redirect ⇒ the interceptor lets the chat turn run normally.
    expect(resolveRedirect("what is a covering index", settings())).toBeNull();
  });

  it("falls through for an unknown bang (normal search instead of erroring)", () => {
    expect(resolveRedirect("!nope find this", settings())).toBeNull();
  });

  it("does NOT redirect a 'go to X' verb phrase (no concrete URL to open)", () => {
    // Classified navigational, but there's no concrete target without a lookup,
    // so it falls through to a normal answer rather than guessing a URL.
    expect(resolveRedirect("go to my email", settings())).toBeNull();
  });

  it("honors a custom bang from settings", () => {
    const s = settings({
      customBangs: [
        { token: "jira", urlTemplate: "https://jira.example.com/search?q={query}" },
      ],
    });
    const r = resolveRedirect("!jira PROJ-42", s);
    expect(r!.url).toBe("https://jira.example.com/search?q=PROJ-42");
  });
});
