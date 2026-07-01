import { ObjectId } from "mongodb";
import { describe, expect, it, vi } from "vitest";

/**
 * Pins the security invariant for memory retrieval: the vector search is ALWAYS
 * pre-filtered by the owning userId (never post-filtered), and superseded
 * memories are excluded. We assert against the aggregation pipeline the function
 * builds rather than a live Atlas query (CLAUDE.md invariant #1).
 */

const { aggregateSpy, updateManySpy, pipelines } = vi.hoisted(() => {
  const pipelines: unknown[][] = [];
  return {
    pipelines,
    updateManySpy: vi.fn(async () => ({})),
    aggregateSpy: vi.fn((pipeline: unknown[]) => {
      pipelines.push(pipeline);
      return { toArray: async () => [] };
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
  $match?: { supersededBy?: unknown; score?: { $gte: number } };
}

describe("retrieveMemories pre-filter", () => {
  it("scopes the vector search to the owner and excludes superseded memories", async () => {
    aggregateSpy.mockClear();
    pipelines.length = 0;
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

    // A later $match drops superseded memories and enforces the score floor.
    const match = pipeline.find((s) => s.$match)?.$match;
    expect(match?.supersededBy).toBeNull();
    expect(typeof match?.score?.$gte).toBe("number");
  });

  it("does not search on an empty query", async () => {
    aggregateSpy.mockClear();
    const out = await retrieveMemories(new ObjectId(), "   ");
    expect(aggregateSpy).not.toHaveBeenCalled();
    expect(out).toEqual([]);
  });
});
