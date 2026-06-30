import { ObjectId } from "mongodb";
import { describe, expect, it, vi } from "vitest";

/**
 * These tests pin the security invariant of document retrieval: the vector
 * search is ALWAYS pre-filtered by the owning userId and restricted to the
 * conversation's attached documents, and it NEVER runs unscoped. We assert
 * against the aggregation pipeline the tool builds rather than a live Atlas
 * query, so the pre-filter is verified deterministically (CLAUDE.md invariant #1
 * and the Phase 2 acceptance criterion on cross-user isolation).
 */

const { aggregateSpy, pipelines } = vi.hoisted(() => {
  const pipelines: unknown[][] = [];
  return {
    pipelines,
    aggregateSpy: vi.fn((pipeline: unknown[]) => {
      pipelines.push(pipeline);
      return { toArray: async () => [] };
    }),
  };
});

vi.mock("../../embeddings/voyage", () => ({
  embedQuery: vi.fn(async () => [0.1, 0.2, 0.3]),
}));

vi.mock("../../db/collections", () => ({
  chunksCol: vi.fn(async () => ({ aggregate: aggregateSpy })),
  documentsCol: vi.fn(async () => ({
    find: vi.fn(() => ({ toArray: vi.fn(async () => []) })),
  })),
}));

// Imported after the mocks are registered.
const { retrieveDocumentsTool } = await import("./retrieveDocuments");

interface VectorSearchStage {
  $vectorSearch: {
    filter: {
      userId: { $eq: ObjectId };
      documentId: { $in: ObjectId[] };
    };
  };
}

describe("retrieve_documents pre-filter", () => {
  it("scopes the vector search to the owner and the attached documents", async () => {
    aggregateSpy.mockClear();
    pipelines.length = 0;
    const userId = new ObjectId();
    const docA = new ObjectId();
    const docB = new ObjectId();

    await retrieveDocumentsTool.invoke(
      { query: "what does the report say?" },
      {
        configurable: {
          userId: userId.toString(),
          attachedDocumentIds: [docA.toString(), docB.toString()],
        },
      },
    );

    expect(aggregateSpy).toHaveBeenCalledOnce();
    const pipeline = pipelines[0] as unknown as VectorSearchStage[];
    const filter = pipeline[0]!.$vectorSearch.filter;

    // Pre-filter is exactly this user...
    expect(filter.userId.$eq.equals(userId)).toBe(true);
    // ...and never some other user.
    expect(filter.userId.$eq.equals(new ObjectId())).toBe(false);
    // ...restricted to exactly the attached documents.
    expect(filter.documentId.$in.map((id) => id.toString())).toEqual([
      docA.toString(),
      docB.toString(),
    ]);
  });

  it("never runs an unscoped search when no documents are attached", async () => {
    aggregateSpy.mockClear();
    const out = await retrieveDocumentsTool.invoke(
      { query: "anything" },
      {
        configurable: {
          userId: new ObjectId().toString(),
          attachedDocumentIds: [],
        },
      },
    );

    expect(aggregateSpy).not.toHaveBeenCalled();
    expect(JSON.parse(out)).toEqual({ results: [] });
  });

  it("refuses to search when the owner id is missing", async () => {
    aggregateSpy.mockClear();
    const out = await retrieveDocumentsTool.invoke(
      { query: "anything" },
      { configurable: { attachedDocumentIds: [new ObjectId().toString()] } },
    );

    expect(aggregateSpy).not.toHaveBeenCalled();
    expect(JSON.parse(out)).toEqual({ results: [] });
  });
});
