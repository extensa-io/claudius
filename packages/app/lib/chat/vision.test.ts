import { describe, expect, it } from "vitest";
import type { InvokeGrant } from "@claudius/shared";
import { assertImagesAllowed, attachedImagesTurnText } from "./vision";

/**
 * The server half of the image policy. Every rejection here is deliberate: the
 * alternative to refusing a turn is dropping the image, which produces a model
 * answering confidently about something it never saw.
 */

function grant(overrides: Partial<InvokeGrant> = {}): InvokeGrant {
  return {
    modelId: "opus-5",
    inferenceProfileId: "us.anthropic.opus-5",
    displayName: "Opus 5",
    role: "member",
    memoryEnabled: true,
    supportsImages: true,
    imagePolicy: { maxPerTurn: 3, maxLongEdgePx: 1568, enforcement: "hard" },
    ...overrides,
  };
}

describe("assertImagesAllowed", () => {
  it("allows a member at the cap", () => {
    expect(() => assertImagesAllowed(3, grant())).not.toThrow();
  });

  it("refuses a member over a hard cap", () => {
    expect(() => assertImagesAllowed(4, grant())).toThrow(
      /up to 3 images per message/,
    );
  });

  it("lets an admin past a soft cap", () => {
    // The warning made the cost visible in the composer; the point of "warn" is
    // that it can be exceeded on purpose.
    const admin = grant({
      role: "admin",
      imagePolicy: { maxPerTurn: 3, maxLongEdgePx: 2576, enforcement: "warn" },
    });
    expect(() => assertImagesAllowed(6, admin)).not.toThrow();
  });

  it("refuses a role with no image policy at all", () => {
    // An absent block is how the guest tier is configured off.
    expect(() =>
      assertImagesAllowed(1, grant({ role: "guest", imagePolicy: null })),
    ).toThrow(/aren't available on your plan/);
  });

  it("refuses an image on a model without vision, naming the model", () => {
    expect(() =>
      assertImagesAllowed(1, grant({ supportsImages: false })),
    ).toThrow(/Opus 5 can't read images/);
  });

  it("checks vision support before the cap, so the clearer error wins", () => {
    expect(() =>
      assertImagesAllowed(9, grant({ supportsImages: false })),
    ).toThrow(/can't read images/);
  });
});

describe("attachedImagesTurnText", () => {
  it("appends a note naming the images so the thread stays coherent", () => {
    // The bytes are gone after this turn; the persisted text is all a later
    // turn (or the user scrolling back) has to go on.
    expect(attachedImagesTurnText("what does this say?", ["receipt.jpg"])).toBe(
      "what does this say?\n\n[attached image: receipt.jpg]",
    );
  });

  it("carries the whole turn on an image-only message", () => {
    expect(attachedImagesTurnText("", ["a.png", "b.png"])).toBe(
      "[attached images: a.png, b.png]",
    );
  });
});
