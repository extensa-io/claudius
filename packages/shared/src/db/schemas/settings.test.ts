import { describe, expect, it } from "vitest";
import {
  ModelCatalogEntrySchema,
  TierSchema,
  TiersSettingsSchema,
} from "./settings";

/**
 * Both Phase 12 settings fields are OPTIONAL, and that is load-bearing: the
 * live `tiers` and `modelCatalog` documents predate them, and a settings read
 * that threw would take down every turn in the app, not just image ones. These
 * tests pin the back-compat and the closed-by-default reading.
 */

const preVisionTier = {
  dailyMessageCap: 50,
  memoryCap: 200,
  monthlyTokenBudget: null,
  features: ["chat"],
};

describe("TierSchema image policy", () => {
  it("parses a tier document written before Phase 12", () => {
    const parsed = TierSchema.parse(preVisionTier);
    expect(parsed.images).toBeUndefined();
  });

  it("treats an absent block as no image service, not a zero cap", () => {
    // Absence IS the off switch — this is how the guest tier is configured.
    const parsed = TierSchema.parse(preVisionTier);
    expect(parsed.images ?? null).toBeNull();
  });

  it("parses a full policy", () => {
    const parsed = TierSchema.parse({
      ...preVisionTier,
      images: { maxPerTurn: 3, maxLongEdgePx: 2576, enforcement: "warn" },
    });
    expect(parsed.images).toEqual({
      maxPerTurn: 3,
      maxLongEdgePx: 2576,
      enforcement: "warn",
    });
  });

  it("rejects a nonsensical policy", () => {
    expect(() =>
      TierSchema.parse({
        ...preVisionTier,
        images: { maxPerTurn: 0, maxLongEdgePx: 1568, enforcement: "hard" },
      }),
    ).toThrow();
    expect(() =>
      TierSchema.parse({
        ...preVisionTier,
        images: { maxPerTurn: 3, maxLongEdgePx: 1568, enforcement: "shout" },
      }),
    ).toThrow();
  });

  it("parses a whole pre-Phase-12 tiers document", () => {
    const parsed = TiersSettingsSchema.parse({
      _id: "tiers",
      admin: preVisionTier,
      member: preVisionTier,
      guest: preVisionTier,
    });
    expect(parsed.guest.images).toBeUndefined();
  });
});

describe("ModelCatalogEntrySchema supportsImages", () => {
  const entry = {
    id: "opus-5",
    inferenceProfileId: "us.anthropic.opus-5",
    displayName: "Opus 5",
    inputPricePerMTok: 5,
    outputPricePerMTok: 25,
    roles: ["admin", "member"],
  };

  it("parses a catalog entry written before Phase 12", () => {
    const parsed = ModelCatalogEntrySchema.parse(entry);
    expect(parsed.supportsImages).toBeUndefined();
  });

  it("reads an absent flag as no vision, never as vision", () => {
    const parsed = ModelCatalogEntrySchema.parse(entry);
    expect(parsed.supportsImages ?? false).toBe(false);
  });

  it("carries the flag when set", () => {
    const parsed = ModelCatalogEntrySchema.parse({
      ...entry,
      supportsImages: true,
    });
    expect(parsed.supportsImages).toBe(true);
  });
});
