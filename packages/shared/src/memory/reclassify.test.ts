import { describe, expect, it } from "vitest";
import { buildReclassifyInput, parseImportanceScores } from "./reclassify";

/**
 * The reclassify SCORING CONTRACT is pure: build a numbered prompt, then map the
 * model's JSON back to an importance per input index. Pinned here so the one-time
 * salience backfill can't silently drop or misalign scores; the model call and DB
 * writes are covered by the migration's live run.
 */

describe("buildReclassifyInput", () => {
  it("numbers memories from zero with their category", () => {
    const input = buildReclassifyInput([
      { content: "Lives in Montreal", category: "fact" },
      { content: "Prefers Vitest", category: "preference" },
    ]);
    expect(input).toBe("[0] (fact) Lives in Montreal\n[1] (preference) Prefers Vitest");
  });
});

describe("parseImportanceScores", () => {
  it("maps scores back to their input index", () => {
    const out = parseImportanceScores(
      '{"scores":[{"i":0,"importance":0.9},{"i":1,"importance":0.3}]}',
      2,
    );
    expect(out).toEqual([0.9, 0.3]);
  });

  it("clamps out-of-range values into [0,1]", () => {
    const out = parseImportanceScores(
      '{"scores":[{"i":0,"importance":1.7},{"i":1,"importance":-0.4}]}',
      2,
    );
    expect(out).toEqual([1, 0]);
  });

  it("leaves un-scored indices null so they get the neutral fallback", () => {
    const out = parseImportanceScores('{"scores":[{"i":1,"importance":0.8}]}', 3);
    expect(out).toEqual([null, 0.8, null]);
  });

  it("returns all-null on malformed output rather than throwing", () => {
    expect(parseImportanceScores("not json", 2)).toEqual([null, null]);
    expect(parseImportanceScores("", 1)).toEqual([null]);
  });

  it("tolerates a leading sentence or markdown fence around the JSON", () => {
    const out = parseImportanceScores(
      'Here you go:\n```json\n{"scores":[{"i":0,"importance":0.5}]}\n```',
      1,
    );
    expect(out).toEqual([0.5]);
  });
});
