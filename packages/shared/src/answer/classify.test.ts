import { describe, expect, it } from "vitest";
import type { SearchSettings } from "../db/schemas";
import { classifyIntent, isFresh, isHighValue } from "./classify";

/**
 * Intent classifier (Phase 8) — the heuristic, rules-first path that runs before
 * the model. Pure and synchronous, so tested directly. Covers each rule and the
 * informational default, plus the depth (high-value) and freshness signals.
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

describe("classifyIntent", () => {
  it("classifies an explicit bang as navigational", () => {
    expect(classifyIntent("!gh langgraph").intent).toBe("navigational");
    expect(classifyIntent("query !w").reason).toBe("bang");
  });

  it("classifies a bare domain / URL as navigational", () => {
    expect(classifyIntent("github.com").intent).toBe("navigational");
    expect(classifyIntent("https://www.bbc.co.uk/news").intent).toBe(
      "navigational",
    );
    expect(classifyIntent("www.mongodb.com/docs").reason).toBe("url_like");
  });

  it("does NOT treat a sentence containing a domain as navigational", () => {
    // Multiple tokens → not URL-like; falls through to informational.
    expect(classifyIntent("is node.js still relevant in 2026").intent).toBe(
      "informational",
    );
  });

  it("classifies an 'open X' verb prefix as navigational", () => {
    expect(classifyIntent("open twitter").intent).toBe("navigational");
    expect(classifyIntent("go to gmail").reason).toBe("nav_prefix");
  });

  it("classifies transactional verbs as transactional", () => {
    expect(classifyIntent("download node 22 for mac").intent).toBe(
      "transactional",
    );
    expect(classifyIntent("cheapest flight to lisbon").intent).toBe(
      "transactional",
    );
  });

  it("defaults to informational", () => {
    const r = classifyIntent("what is a covering index in mongodb");
    expect(r.intent).toBe("informational");
    expect(r.reason).toBe("default_informational");
    expect(r.highValue).toBe(false);
  });

  it("flags an informational depth signal as high value", () => {
    const r = classifyIntent("compare postgres vs mongodb for time series");
    expect(r.intent).toBe("informational");
    expect(r.highValue).toBe(true);
  });

  it("honors custom escalation keywords from settings", () => {
    const s = settings({ escalationKeywords: ["deep-dive-please"] });
    expect(isHighValue("give me a deep-dive-please", s)).toBe(true);
    // The default keyword no longer applies when settings override the list.
    expect(isHighValue("compare a and b", s)).toBe(false);
  });
});

describe("isFresh", () => {
  it("detects news-like / time-sensitive queries", () => {
    expect(isFresh("bitcoin price today")).toBe(true);
    expect(isFresh("latest react release")).toBe(true);
    expect(isFresh("history of the roman empire")).toBe(false);
  });
});
