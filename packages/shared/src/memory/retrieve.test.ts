import { ObjectId } from "mongodb";
import { describe, expect, it, vi } from "vitest";

/**
 * Pins the memory retrieval contract:
 *   1. The security invariant (CLAUDE.md #1): the vector search is ALWAYS
 *      pre-filtered by the owning userId, never post-filtered, and superseded
 *      memories are excluded — for both the retrieval and profile paths.
 *   2. The Phase 6 ranking: importance blends into the score so a defining fact
 *      outranks a trivial phrase-match, adaptive thresholding keeps the relevant
 *      band, and the never-blind fallback still returns the top few on a miss.
 *   3. The always-on profile: highest-importance identity rows, chosen without a
 *      vector search and tagged as `profile`.
 * We assert against the aggregation/query the functions build and their
 * selection behaviour, not a live Atlas query.
 */

const { aggregateSpy, updateManySpy, findSpy, pipelines, setHits, setProfileRows } =
  vi.hoisted(() => {
    const pipelines: unknown[][] = [];
    let hits: unknown[] = [];
    let profileRows: unknown[] = [];
    const chain = {
      sort: () => chain,
      limit: () => chain,
      project: () => chain,
      toArray: async () => profileRows,
    };
    return {
      pipelines,
      setHits: (next: unknown[]) => {
        hits = next;
      },
      setProfileRows: (next: unknown[]) => {
        profileRows = next;
      },
      updateManySpy: vi.fn(async () => ({})),
      findSpy: vi.fn((filter?: unknown) => {
        void filter; // recorded via mock.calls; referenced to satisfy lint
        return chain;
      }),
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
    find: findSpy,
  })),
}));

const { retrieveMemories, getProfileMemories } = await import("./retrieve");

interface VectorSearchStage {
  $vectorSearch: { filter: { userId: { $eq: ObjectId } } };
}
interface MatchStage {
  $match?: { supersededBy?: unknown };
}

function hit(content: string, score: number, importance = 0.5) {
  return {
    _id: new ObjectId(),
    content,
    category: "fact" as const,
    score,
    importance,
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

    const filter = pipeline[0]!.$vectorSearch.filter;
    expect(filter.userId.$eq.equals(userId)).toBe(true);
    expect(filter.userId.$eq.equals(new ObjectId())).toBe(false);

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

  it("tags retrieved memories with source 'retrieved'", async () => {
    setHits([hit("a", 0.7), hit("b", 0.66), hit("c", 0.62)]);
    const out = await retrieveMemories(new ObjectId(), "what do I do?");
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((m) => m.source === "retrieved")).toBe(true);
  });
});

describe("retrieveMemories salience blend", () => {
  it("lifts a defining memory above a higher-scoring trivial one", async () => {
    // Trivial phrase-match scores higher on cosine, but the defining fact's
    // importance blends it to the top — the Phase 6 fix for a flat store.
    setHits([
      hit("trivial", 0.66, 0.1),
      hit("defining", 0.6, 0.95),
    ]);
    const out = await retrieveMemories(new ObjectId(), "who am I?");
    expect(out[0]?.content).toBe("defining");
  });

  it("excludes profile ids so the two paths don't double-inject", async () => {
    const shared = hit("in-profile", 0.8);
    setHits([shared, hit("fresh", 0.7)]);
    const out = await retrieveMemories(new ObjectId(), "what do I do?", [
      shared._id.toString(),
    ]);
    const contents = out.map((m) => m.content);
    expect(contents).toContain("fresh");
    expect(contents).not.toContain("in-profile");
  });
});

describe("retrieveMemories adaptive threshold + never-blind", () => {
  it("keeps the band around the top blended score when enough clear it", async () => {
    setHits([hit("x", 0.7), hit("y", 0.66), hit("z", 0.61), hit("w", 0.4)]);
    const out = await retrieveMemories(new ObjectId(), "what do I do?");
    // w is far below the band and the floor; it must never appear.
    expect(out.map((m) => m.content)).not.toContain("w");
  });

  it("falls back to the top few by blended score when none clears the band", async () => {
    setHits([hit("x", 0.52), hit("y", 0.51), hit("z", 0.5), hit("w", 0.48)]);
    const out = await retrieveMemories(new ObjectId(), "do you know who I am?");
    const contents = out.map((m) => m.content);
    expect(contents).toContain("x");
    expect(contents).not.toContain("w");
    expect(contents.length).toBeGreaterThanOrEqual(3);
  });
});

describe("getProfileMemories", () => {
  it("returns defining rows tagged as profile, owner-scoped", async () => {
    findSpy.mockClear();
    setProfileRows([
      { _id: new ObjectId(), content: "Developer Advocate at MongoDB", category: "fact" },
      { _id: new ObjectId(), content: "Based in Montreal", category: "fact" },
    ]);
    const userId = new ObjectId();
    const out = await getProfileMemories(userId);

    // The find filter is the owner, active rows, above the profile importance bar.
    const filter = findSpy.mock.calls[0]![0] as unknown as {
      userId: ObjectId;
      supersededBy: null;
      importance: { $gte: number };
    };
    expect(filter.userId.equals(userId)).toBe(true);
    expect(filter.supersededBy).toBeNull();
    expect(filter.importance.$gte).toBeGreaterThan(0.5);

    expect(out).toHaveLength(2);
    expect(out.every((m) => m.source === "profile")).toBe(true);
  });

  it("returns an empty profile when no row is defining enough", async () => {
    setProfileRows([]);
    const out = await getProfileMemories(new ObjectId());
    expect(out).toEqual([]);
  });
});
