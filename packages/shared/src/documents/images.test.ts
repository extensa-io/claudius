import { ObjectId } from "mongodb";
import { beforeEach, describe, expect, it, vi } from "vitest";

const find = vi.fn();
vi.mock("../db/collections", () => ({
  documentsCol: () => Promise.resolve({ find }),
}));

const { resolveTurnImages } = await import("./images");

/**
 * Resolving a turn's images is an ownership boundary (invariant #1): the filter
 * is on the query, not applied afterwards, so another user's image id can never
 * come back even in principle.
 */

const USER = new ObjectId();

function mockDocs(docs: unknown[]): void {
  find.mockReturnValue({ toArray: () => Promise.resolve(docs) });
}

function doc(id: ObjectId, filename: string, mimeType = "image/jpeg") {
  return {
    _id: id,
    filename,
    mimeType,
    blobUrl: `https://blob.example/${filename}`,
  };
}

beforeEach(() => {
  find.mockReset();
});

describe("resolveTurnImages", () => {
  it("filters by userId AND ready status in the query itself", async () => {
    const id = new ObjectId();
    mockDocs([doc(id, "a.jpg")]);

    await resolveTurnImages(USER, [id.toString()]);

    const [filter] = find.mock.calls[0]!;
    expect(filter).toMatchObject({ userId: USER, status: "ready" });
    expect(filter._id.$in).toHaveLength(1);
  });

  it("returns images in the order they were attached, not query order", async () => {
    const a = new ObjectId();
    const b = new ObjectId();
    // Mongo returns them however it likes; the model should see the user's order.
    mockDocs([doc(b, "second.png", "image/png"), doc(a, "first.jpg")]);

    const out = await resolveTurnImages(USER, [a.toString(), b.toString()]);
    expect(out.map((i) => i.filename)).toEqual(["first.jpg", "second.png"]);
  });

  it("drops an id that did not come back, rather than inventing one", async () => {
    const a = new ObjectId();
    const missing = new ObjectId();
    mockDocs([doc(a, "a.jpg")]);

    const out = await resolveTurnImages(USER, [
      a.toString(),
      missing.toString(),
    ]);
    // The route compares lengths and refuses the turn, so a dropped id surfaces
    // as an error to the user instead of a silently missing image.
    expect(out).toHaveLength(1);
  });

  it("drops a record whose MIME type is not one Bedrock accepts", async () => {
    const id = new ObjectId();
    mockDocs([doc(id, "old.heic", "image/heic")]);
    expect(await resolveTurnImages(USER, [id.toString()])).toEqual([]);
  });

  it("skips the query entirely for an empty or malformed id list", async () => {
    expect(await resolveTurnImages(USER, [])).toEqual([]);
    expect(await resolveTurnImages(USER, ["not-an-objectid"])).toEqual([]);
    expect(find).not.toHaveBeenCalled();
  });

  it("carries the blob URL through so hydration needs no second lookup", async () => {
    // That second lookup would be a read by id alone — a query on user-owned
    // data without an owner filter. Not needing it is the point.
    const id = new ObjectId();
    mockDocs([doc(id, "a.jpg")]);
    const [image] = await resolveTurnImages(USER, [id.toString()]);
    expect(image?.blobUrl).toBe("https://blob.example/a.jpg");
  });
});
