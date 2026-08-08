import { describe, expect, it, vi } from "vitest";

// aggregate.ts imports the db layer (eager-connecting client) transitively.
vi.mock("../db/client", () => ({
  getDb: vi.fn(async () => ({})),
  getClient: () => Promise.resolve({}),
  DB_NAME: "claudius",
}));

const {
  buildPriceMap,
  costUsd,
  startOfUtcDay,
  startOfUtcMonth,
  startOfPreviousUtcMonth,
} = await import("./aggregate");
import type { ModelCatalogEntry } from "../db/schemas";

function entry(overrides: Partial<ModelCatalogEntry>): ModelCatalogEntry {
  return {
    id: "m",
    inferenceProfileId: "profile",
    displayName: "M",
    inputPricePerMTok: 1,
    outputPricePerMTok: 2,
    roles: ["member"],
    ...overrides,
  };
}

describe("buildPriceMap", () => {
  it("clamps unconfirmed (-1) prices to 0 so bad data can't lower a total", () => {
    const map = buildPriceMap([
      entry({ id: "haiku", inputPricePerMTok: -1, outputPricePerMTok: -1 }),
    ]);
    expect(map.get("haiku")).toEqual({ input: 0, output: 0 });
  });

  it("keeps real prices intact", () => {
    const map = buildPriceMap([
      entry({ id: "opus", inputPricePerMTok: 5, outputPricePerMTok: 25 }),
    ]);
    expect(map.get("opus")).toEqual({ input: 5, output: 25 });
  });
});

describe("costUsd", () => {
  it("prices tokens per million", () => {
    const map = buildPriceMap([
      entry({ id: "opus", inputPricePerMTok: 5, outputPricePerMTok: 25 }),
    ]);
    // 1M input @ $5 + 0.5M output @ $25 = 5 + 12.5
    expect(costUsd(map, "opus", 1_000_000, 500_000)).toBeCloseTo(17.5, 6);
  });

  it("returns 0 for an unknown model", () => {
    expect(costUsd(buildPriceMap([]), "ghost", 1_000_000, 1_000_000)).toBe(0);
  });
});

describe("UTC boundaries", () => {
  it("startOfUtcDay floors to midnight", () => {
    expect(
      startOfUtcDay(new Date("2026-07-01T13:45:00Z")).toISOString(),
    ).toBe("2026-07-01T00:00:00.000Z");
  });

  it("startOfUtcMonth floors to the first", () => {
    expect(
      startOfUtcMonth(new Date("2026-07-18T09:00:00Z")).toISOString(),
    ).toBe("2026-07-01T00:00:00.000Z");
  });

  it("startOfPreviousUtcMonth crosses the year boundary", () => {
    expect(
      startOfPreviousUtcMonth(new Date("2026-01-09T00:00:00Z")).toISOString(),
    ).toBe("2025-12-01T00:00:00.000Z");
  });
});
