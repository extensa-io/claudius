import { describe, expect, it } from "vitest";
import type { Bang } from "../db/schemas";
import { hasBang, mergeBangs, resolveBang } from "./bangs";

/**
 * Bang parsing (Phase 8) — a pure module, so tested without any I/O. Covers the
 * spec's cases: leading and trailing bang, URL-encoded substitution, no-query
 * home resolution, unknown-bang fall-through, and custom-over-builtin merge.
 */

const custom: Bang[] = [
  { token: "j", urlTemplate: "https://jira.example.com/search?q={query}" },
  // Override a built-in: a custom !gh wins over the default table.
  { token: "gh", urlTemplate: "https://ghe.internal/search?q={query}" },
];

describe("resolveBang", () => {
  it("resolves a leading bang against the built-in table", () => {
    const r = resolveBang("!gh langgraph checkpoint");
    expect(r).not.toBeNull();
    expect(r!.token).toBe("gh");
    expect(r!.url).toBe(
      "https://github.com/search?q=langgraph%20checkpoint&type=repositories",
    );
  });

  it("resolves a trailing bang", () => {
    const r = resolveBang("mongodb aggregation !so");
    expect(r).not.toBeNull();
    expect(r!.token).toBe("so");
    expect(r!.url).toBe(
      "https://stackoverflow.com/search?q=mongodb%20aggregation",
    );
  });

  it("URL-encodes the remaining query", () => {
    const r = resolveBang("!g c++ & rust");
    expect(r!.url).toBe("https://www.google.com/search?q=c%2B%2B%20%26%20rust");
  });

  it("substitutes empty for a bang with no query (site home/search)", () => {
    const r = resolveBang("!w");
    expect(r!.url).toBe("https://en.wikipedia.org/w/index.php?search=");
  });

  it("returns null for an unknown bang (caller falls through to search)", () => {
    expect(resolveBang("!nope find this")).toBeNull();
  });

  it("returns null when there is no bang", () => {
    expect(resolveBang("what is a covering index")).toBeNull();
  });

  it("treats a bare ! as not a bang", () => {
    expect(resolveBang("wat! really")).toBeNull();
    expect(resolveBang("!")).toBeNull();
  });

  it("merges custom bangs over the built-in table (custom wins)", () => {
    const gh = resolveBang("!gh thing", custom);
    expect(gh!.url).toBe("https://ghe.internal/search?q=thing");
    const j = resolveBang("!j PROJ-1", custom);
    expect(j!.url).toBe("https://jira.example.com/search?q=PROJ-1");
  });

  it("is case-insensitive on the token", () => {
    const r = resolveBang("!GH thing");
    expect(r!.token).toBe("gh");
  });
});

describe("hasBang", () => {
  it("detects a leading or trailing bang, ignores plain text", () => {
    expect(hasBang("!gh x")).toBe(true);
    expect(hasBang("x !gh")).toBe(true);
    expect(hasBang("just a question")).toBe(false);
  });
});

describe("mergeBangs", () => {
  it("includes built-ins and lets custom override", () => {
    const table = mergeBangs(custom);
    expect(table.get("w")).toContain("wikipedia");
    expect(table.get("gh")).toBe("https://ghe.internal/search?q={query}");
    expect(table.get("j")).toBe("https://jira.example.com/search?q={query}");
  });
});
