import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SearchSettings } from "../db/schemas";

/**
 * The Brave free-tier counter: month marker, in-memory rollover read, and the
 * durable atomic increment/rollover. `settingsCol` is mocked so the update
 * queries are asserted without a database.
 */

const findOneAndUpdate = vi.fn();

vi.mock("../db/client", () => ({
  getDb: vi.fn(async () => ({})),
  getClient: () => Promise.resolve({}),
  DB_NAME: "claudius",
}));
vi.mock("../db/collections", () => ({
  settingsCol: vi.fn(async () => ({ findOneAndUpdate })),
  usersCol: vi.fn(async () => ({})),
}));

const { utcMonthMarker, braveCountThisMonth, recordBraveCall } = await import(
  "./catalog"
);

const usage = (
  month: string,
  count: number,
): SearchSettings["braveUsage"] => ({ month, count });

describe("utcMonthMarker", () => {
  it("formats a date as YYYY-MM in UTC, zero-padded", () => {
    expect(utcMonthMarker(new Date("2026-03-09T00:00:00Z"))).toBe("2026-03");
    expect(utcMonthMarker(new Date("2026-12-31T23:59:59Z"))).toBe("2026-12");
  });
});

describe("braveCountThisMonth", () => {
  const now = new Date("2026-07-15T12:00:00Z");

  it("returns the stored count when the marker is the current month", () => {
    expect(braveCountThisMonth(usage("2026-07", 42), now)).toBe(42);
  });

  it("treats a stale (past-month) marker as zero without writing", () => {
    expect(braveCountThisMonth(usage("2026-06", 999), now)).toBe(0);
  });
});

describe("recordBraveCall", () => {
  const now = new Date("2026-07-15T12:00:00Z");

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("increments in place when the stored month is current", async () => {
    findOneAndUpdate.mockResolvedValueOnce({
      _id: "search",
      braveUsage: { month: "2026-07", count: 6 },
    });
    const count = await recordBraveCall(now);
    expect(count).toBe(6);
    // First attempt targets the current-month doc with a $inc.
    expect(findOneAndUpdate).toHaveBeenCalledWith(
      { _id: "search", "braveUsage.month": "2026-07" },
      { $inc: { "braveUsage.count": 1 } },
      { returnDocument: "after" },
    );
  });

  it("rolls the month over and resets the count to 1 when the marker is stale", async () => {
    // Same-month bump misses (no current-month doc yet), rollover branch sets it.
    findOneAndUpdate
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        _id: "search",
        braveUsage: { month: "2026-07", count: 1 },
      });
    const count = await recordBraveCall(now);
    expect(count).toBe(1);
    expect(findOneAndUpdate).toHaveBeenNthCalledWith(
      2,
      { _id: "search", "braveUsage.month": { $ne: "2026-07" } },
      { $set: { "braveUsage.month": "2026-07", "braveUsage.count": 1 } },
      { returnDocument: "after" },
    );
  });

  it("falls through to a plain increment if a racing writer already rolled the month", async () => {
    findOneAndUpdate
      .mockResolvedValueOnce(null) // same-month bump missed
      .mockResolvedValueOnce(null) // rollover lost the race
      .mockResolvedValueOnce({
        _id: "search",
        braveUsage: { month: "2026-07", count: 2 },
      });
    const count = await recordBraveCall(now);
    expect(count).toBe(2);
    expect(findOneAndUpdate).toHaveBeenCalledTimes(3);
  });
});
