import { describe, expect, it, vi } from "vitest";

// persist.ts transitively imports the db layer, whose client connects eagerly at
// module load. Stub the client so importing the pure decision code never opens a
// Mongo connection during unit tests.
vi.mock("../db/client", () => ({
  getDb: vi.fn(async () => ({})),
  getClient: () => Promise.resolve({}),
  DB_NAME: "claudius",
}));

const { decidePersistence, normalize } = await import("./persist");

/**
 * The dedup/supersession decision, unit-tested as a pure function (no DB, no
 * embeddings). It encodes the rule the article calls out: vector similarity plus
 * a text check decides skip vs. supersede vs. insert — no extra model call.
 * Acceptance: "updating a fact supersedes rather than duplicates."
 */
describe("decidePersistence", () => {
  it("inserts when there is no neighbor", () => {
    expect(decidePersistence("Lives in Montreal", undefined)).toBe("insert");
  });

  it("inserts when the nearest neighbor is only weakly similar", () => {
    expect(
      decidePersistence("Lives in Montreal", {
        content: "Enjoys hiking",
        score: 0.7,
      }),
    ).toBe("insert");
  });

  it("skips a high-similarity restatement of the same content", () => {
    expect(
      decidePersistence("Prefers Vitest over Jest.", {
        content: "prefers vitest over jest",
        score: 0.99,
      }),
    ).toBe("skip");
  });

  it("supersedes when a high-similarity neighbor has different content", () => {
    // Same topic (where the user lives), updated value -> supersede, not dupe.
    expect(
      decidePersistence("Now based in Montreal", {
        content: "Based in Toronto",
        score: 0.93,
      }),
    ).toBe("supersede");
  });
});

describe("normalize", () => {
  it("ignores case, punctuation, and whitespace differences", () => {
    expect(normalize("Prefers Vitest over Jest!")).toBe(
      normalize("prefers   vitest over jest"),
    );
  });
});
