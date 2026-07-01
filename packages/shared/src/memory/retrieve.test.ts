import { ObjectId } from "mongodb";
import { describe, expect, it, vi } from "vitest";

/**
 * Pins two things about memory retrieval:
 *   1. The security invariant (CLAUDE.md #1): the vector search is ALWAYS
 *      pre-filtered by the owning userId, never post-filtered, and superseded
 *      memories are excluded.
 *   2. The post-Phase-3 calibration: the similarity floor is applied in code
 *      (not the pipeline) so a never-blind fallback can return the top few
 *      memories even when none clears the floor.
 * We assert against the aggregation pipeline the function builds and against the
 * selection behaviour, rather than a live Atlas query.
 */

const { aggregateSpy, updateManySpy, pipelines, setHits } = vi.hoisted(() => {
  const pipelines: unknown[][] = [];
  let hits: unknown[] = [];
  return {
    pipelines,
    setHits: (next: unknown[]) => {
      hits = next;
    },
    updateManySpy: vi.fn(async () => ({})),
    aggregateSpy: vi.fn((pipeline: unknown[]) => {
      pipelines.push(pipeline);
      return { toArray: async () => hits };
    }),
  };
});

vi.mock("../embeddings/voyage", () => ({
  embedQuery: vi.fn(async () => [0.1, 0.2, 0.3]),
}));

vi.mock("../db/collections", () => ({
  memoriesCol: vi.fn(async () => ({
    aggregate: aggregateSpy,
    updateMany: updateManySpy,
  })),
}));

const { retrieveMemories } = await import("./retrieve");

interface VectorSearchStage {
  $vectorSearch: { filter: { userId: { $eq: ObjectId } } };
}
interface MatchStage {
  $match?: { supersededBy?: unknown };
}

function hit(content: string, score: number) {
  return {
    _id: new ObjectId(),
    content,
    category: "fact" as const,
    score,
  };
}

describe("retrieveMemories pre-filter", () => {
  it("scopes the vector search to the owner and excludes superseded memories", async () => {
    aggregateSpy.mockClear();
    pipelines.length = 0;
    setHits([]);
    const userId = new ObjectId();

    await retrieveMemories(userId, "where do I live?");

    expect(aggregateSpy).toHaveBeenCalledOnce();
    const pipeline = pipelines[0] as unknown as Array<
      VectorSearchStage & MatchStage
    >;

    // Pre-filter is exactly this user, never another.
    const filter = pipeline[0]!.$vectorSearch.filter;
    expect(filter.userId.$eq.equals(userId)).toBe(true);
    expect(filter.userId.$eq.equals(new ObjectId())).toBe(false);

    // A later $match drops superseded memories. The score floor is NOT in the
    // pipeline anymore — it's applied in code so the fallback can reach below it.
    const match = pipeline.find((s) => s.$match)?.$match;
    expect(match?.supersededBy).toBeNull();
  });

  it("does not search on an empty query", async () => {
    aggregateSpy.mockClear();
    setHits([]);
    const out = await retrieveMemories(new ObjectId(), "   ");
    expect(aggregateSpy).not.toHaveBeenCalled();
    expect(out).toEqual([]);
  });
});

describe("retrieveMemories floor and never-blind fallback", () => {
  it("returns only memories that clear the floor when enough do", async () => {
    setHits([
      hit("a", 0.7),
      hit("b", 0.66),
      hit("c", 0.61),
      hit("weak", 0.4),
    ]);
    const out = await retrieveMemories(new ObjectId(), "what do I do?");
    const contents = out.map((m) => m.content);
    expect(contents).toEqual(["a", "b", "c"]);
    expect(contents).not.toContain("weak");
  });

  it("falls back to the top few by score when none clears the floor", async () => {
    setHits([
      hit("x", 0.52),
      hit("y", 0.51),
      hit("z", 0.5),
      hit("w", 0.48),
    ]);
    const out = await retrieveMemories(new ObjectId(), "do you know who I am?");
    const contents = out.map((m) => m.content);
    // MIN_INJECT top-3 by score, so the model is never fully blind.
    expect(contents).toEqual(["x", "y", "z"]);
    expect(contents).not.toContain("w");
  });
});
