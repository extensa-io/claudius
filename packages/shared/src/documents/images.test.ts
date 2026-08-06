import { ObjectId } from "mongodb";
import { beforeEach, describe, expect, it, vi } from "vitest";

const find = vi.fn();
vi.mock("../db/collections", () => ({
  documentsCol: () => Promise.resolve({ find }),
}));

const blobGet = vi.fn();
vi.mock("@vercel/blob", () => ({
  get: (...args: unknown[]) => blobGet(...args),
}));
vi.mock("../env", () => ({
  appEnv: () => ({ BLOB_READ_WRITE_TOKEN: "token" }),
}));

const { resolveTurnImages, hydrateTurnImages } = await import("./images");

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
  blobGet.mockReset();
});

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
const WEBP = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
]);

describe("hydrateTurnImages", () => {
  function mockBlob(bytes: Uint8Array): void {
    blobGet.mockResolvedValue({
      stream: new Response(bytes as unknown as BodyInit).body,
    });
  }

  const image = {
    id: "abc",
    filename: "photo.jpg",
    mimeType: "image/jpeg",
    blobUrl: "https://blob.example/photo.jpg",
  };

  it("declares the type the BYTES say, not the one the extension claimed", async () => {
    // A WebP downloaded as .jpg. Bedrock cross-checks the declared media type
    // against the bytes and rejects the mismatch, so the bytes have to win.
    mockBlob(WEBP);
    const [out] = await hydrateTurnImages([image]);
    expect(out?.mimeType).toBe("image/webp");
  });

  it("keeps the stored type when the bytes agree", async () => {
    mockBlob(JPEG);
    const [out] = await hydrateTurnImages([image]);
    expect(out?.mimeType).toBe("image/jpeg");
  });
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
