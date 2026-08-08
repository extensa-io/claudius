import { describe, expect, it, vi } from "vitest";

// extract.ts transitively imports the db layer, whose client connects eagerly at
// module load. Stub the client so importing the pure parse/filter code never
// opens a Mongo connection during unit tests.
vi.mock("../db/client", () => ({
  getDb: vi.fn(async () => ({})),
  getClient: () => Promise.resolve({}),
  DB_NAME: "claudius",
}));

const { CONFIDENCE_THRESHOLD, selectCandidates } = await import("./extract");

/**
 * The confidence filter is what keeps small talk out of long-term memory. These
 * tests exercise the pure parse-and-filter step with fixture model output, so the
 * behavior is pinned without a live Haiku call (acceptance: "small talk produces
 * zero memories").
 */
describe("selectCandidates", () => {
  it("keeps only high-confidence candidates", () => {
    const raw = JSON.stringify({
      memories: [
        { content: "Prefers Vitest over Jest", category: "preference", confidence: 0.95 },
        { content: "Is based in Montreal", category: "fact", confidence: 0.8 },
      ],
    });
    const out = selectCandidates(raw);
    expect(out).toHaveLength(2);
  });

  it("drops small talk rated below the threshold", () => {
    // What the model returns for a chit-chat exchange: nothing durable, all low.
    const raw = JSON.stringify({
      memories: [
        { content: "Said thanks", category: "context", confidence: 0.2 },
        { content: "Was in a good mood", category: "context", confidence: 0.3 },
      ],
    });
    expect(selectCandidates(raw)).toEqual([]);
  });

  it("treats exactly-threshold confidence as high enough", () => {
    const raw = JSON.stringify({
      memories: [
        { content: "Works at a database company", category: "fact", confidence: CONFIDENCE_THRESHOLD },
      ],
    });
    expect(selectCandidates(raw)).toHaveLength(1);
  });

  it("returns nothing for an empty memory list", () => {
    expect(selectCandidates(JSON.stringify({ memories: [] }))).toEqual([]);
  });

  it("tolerates a markdown-fenced or chatty reply", () => {
    const raw =
      'Sure! Here you go:\n```json\n{"memories":[{"content":"Runs marathons","category":"fact","confidence":0.9}]}\n```';
    const out = selectCandidates(raw);
    expect(out).toHaveLength(1);
    expect(out[0]!.content).toBe("Runs marathons");
  });

  it("returns nothing for unparseable output", () => {
    expect(selectCandidates("not json at all")).toEqual([]);
  });
});
