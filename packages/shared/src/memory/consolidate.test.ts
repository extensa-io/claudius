import { describe, expect, it } from "vitest";
import { buildClusters, pickCanonical } from "./consolidate";

/**
 * The consolidation MERGE DECISION — which near-duplicate rows collapse together
 * and which survives — is pure, so it's pinned here without a database. The DB
 * side (neighbor search, supersede writes, prune) is exercised in the live
 * verification runbook.
 */

describe("buildClusters", () => {
  it("groups transitively connected ids and drops singletons", () => {
    // a-b-c are a chain (a~b, b~c); d-e are a pair; f is alone.
    const clusters = buildClusters(
      ["a", "b", "c", "d", "e", "f"],
      [
        ["a", "b"],
        ["b", "c"],
        ["d", "e"],
      ],
    );
    const normalized = clusters.map((c) => [...c].sort()).sort();
    expect(normalized).toEqual([
      ["a", "b", "c"],
      ["d", "e"],
    ]);
  });

  it("returns no clusters when nothing is near-duplicate", () => {
    expect(buildClusters(["a", "b", "c"], [])).toEqual([]);
  });

  it("ignores edges to ids not in the set", () => {
    // A stale edge (b already merged away) must not resurrect a cluster.
    const clusters = buildClusters(["a", "b"], [["a", "ghost"]]);
    expect(clusters).toEqual([]);
  });
});

describe("pickCanonical", () => {
  it("keeps the most important member", () => {
    const winner = pickCanonical([
      { id: "low", importance: 0.3, createdAt: 100 },
      { id: "high", importance: 0.9, createdAt: 50 },
    ]);
    expect(winner).toBe("high");
  });

  it("breaks ties by recency", () => {
    const winner = pickCanonical([
      { id: "older", importance: 0.7, createdAt: 100 },
      { id: "newer", importance: 0.7, createdAt: 200 },
    ]);
    expect(winner).toBe("newer");
  });
});
