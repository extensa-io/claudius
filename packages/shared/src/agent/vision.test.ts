import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { ObjectId } from "mongodb";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The hydration path reads Mongo and Blob; both are stubbed so these tests
// exercise the message-shaping logic, which is where the invariant lives.
const resolveTurnImages = vi.fn();
const hydrateTurnImages = vi.fn();
vi.mock("../documents/images", () => ({
  resolveTurnImages: (...args: unknown[]) => resolveTurnImages(...args),
  hydrateTurnImages: (...args: unknown[]) => hydrateTurnImages(...args),
}));

const { withHydratedImages } = await import("./graph");

const USER_ID = new ObjectId().toString();
const IMAGE = {
  id: "img1",
  filename: "receipt.jpg",
  mimeType: "image/jpeg",
  blobUrl: "https://blob.example/receipt.jpg",
};
// Stands in for real image bytes: long enough that its presence in a serialized
// checkpoint would be unmistakable.
const BASE64 = "QUJDRA==".repeat(500);

function thread(): Array<AIMessage | HumanMessage> {
  return [
    new HumanMessage("hello"),
    new AIMessage("hi there"),
    new HumanMessage("what does this say?"),
  ];
}

beforeEach(() => {
  resolveTurnImages.mockReset().mockResolvedValue([IMAGE]);
  hydrateTurnImages
    .mockReset()
    .mockResolvedValue([{ ...IMAGE, base64: BASE64 }]);
});

describe("withHydratedImages", () => {
  it("passes the thread through untouched when no images are attached", async () => {
    const messages = thread();
    const out = await withHydratedImages(messages, {
      imageIds: [],
      userId: USER_ID,
    });
    expect(out).toBe(messages);
    expect(resolveTurnImages).not.toHaveBeenCalled();
  });

  it("attaches images to the LAST human turn, not an earlier one", async () => {
    const messages = thread();
    const out = await withHydratedImages(messages, {
      imageIds: ["img1"],
      userId: USER_ID,
    });

    expect(out[0]).toBe(messages[0]);
    expect(out[1]).toBe(messages[1]);
    const content = out[2]!.content as Array<Record<string, unknown>>;
    expect(Array.isArray(content)).toBe(true);
    expect(content[0]).toMatchObject({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: BASE64 },
    });
    expect(content[1]).toMatchObject({
      type: "text",
      text: "what does this say?",
    });
  });

  it("NEVER mutates the caller's messages — the persisted turn stays text-only", async () => {
    // This is the whole design. state.messages is what the checkpointer writes;
    // if hydration touched it, a base64 image would be rewritten into every
    // checkpoint of every later turn on this thread.
    const messages = thread();
    const before = JSON.stringify(messages.map((m) => m.content));

    await withHydratedImages(messages, { imageIds: ["img1"], userId: USER_ID });

    expect(JSON.stringify(messages.map((m) => m.content))).toBe(before);
    expect(JSON.stringify(messages)).not.toContain(BASE64);
  });

  it("keeps a would-be checkpoint of the original thread within a hair of a text-only one", async () => {
    // A proxy for acceptance criterion 3: the state the checkpointer would
    // serialize after an image turn must be the same size as after a text turn.
    const textOnly = thread();
    const imageTurn = thread();
    await withHydratedImages(imageTurn, {
      imageIds: ["img1"],
      userId: USER_ID,
    });

    const sizeOf = (m: unknown[]): number => JSON.stringify(m).length;
    expect(sizeOf(imageTurn)).toBe(sizeOf(textOnly));
    // And the ephemeral copy really did carry the bytes, so the equality above
    // is not passing because hydration silently no-opped.
    expect(hydrateTurnImages).toHaveBeenCalledOnce();
  });

  it("omits the text block entirely on an image-only turn", async () => {
    // Bedrock rejects an empty text block, and "" carries no meaning anyway.
    const messages = [new HumanMessage("")];
    const out = await withHydratedImages(messages, {
      imageIds: ["img1"],
      userId: USER_ID,
    });
    const content = out[0]!.content as Array<Record<string, unknown>>;
    expect(content).toHaveLength(1);
    expect(content[0]).toMatchObject({ type: "image" });
  });

  it("sends every attached image, in the order they were attached", async () => {
    const second = { ...IMAGE, id: "img2", filename: "page2.png", mimeType: "image/png" };
    resolveTurnImages.mockResolvedValue([IMAGE, second]);
    hydrateTurnImages.mockResolvedValue([
      { ...IMAGE, base64: "AAAA" },
      { ...second, base64: "BBBB" },
    ]);

    const out = await withHydratedImages(thread(), {
      imageIds: ["img1", "img2"],
      userId: USER_ID,
    });
    const content = out[2]!.content as Array<Record<string, unknown>>;
    expect(content.map((c) => c.type)).toEqual(["image", "image", "text"]);
  });

  it("passes the thread through when the owner is unknown", async () => {
    // No userId means no ownership-filtered read is possible, so nothing is
    // hydrated (invariant #1: never read user data without an owner filter).
    const messages = thread();
    const out = await withHydratedImages(messages, {
      imageIds: ["img1"],
      userId: undefined,
    });
    expect(out).toBe(messages);
    expect(resolveTurnImages).not.toHaveBeenCalled();
  });

  it("passes the thread through when the images resolve to nothing", async () => {
    resolveTurnImages.mockResolvedValue([]);
    hydrateTurnImages.mockResolvedValue([]);
    const messages = thread();
    const out = await withHydratedImages(messages, {
      imageIds: ["gone"],
      userId: USER_ID,
    });
    expect(out).toBe(messages);
  });

  it("propagates a hydration failure instead of answering about an unseen image", async () => {
    hydrateTurnImages.mockRejectedValue(new Error("blob unreachable"));
    await expect(
      withHydratedImages(thread(), { imageIds: ["img1"], userId: USER_ID }),
    ).rejects.toThrow("blob unreachable");
  });
});
