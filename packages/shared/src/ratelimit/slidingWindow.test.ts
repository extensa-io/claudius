import { ObjectId } from "mongodb";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The sliding-window limiter, exercised against an in-memory fake of the one
 * document it touches. Proves the core contract: up to `limit` hits inside the
 * window are allowed, the next is denied, and the window slides as time passes.
 */

interface FakeDoc {
  userId: ObjectId;
  key: string;
  hits: Date[];
  updatedAt: Date;
}

let doc: FakeDoc | null = null;

const fakeCol = {
  // Applies $pull (drop hits < windowStart), $set, $setOnInsert; returns after.
  findOneAndUpdate: vi.fn(
    async (
      filter: { userId: ObjectId; key: string },
      update: {
        $pull: { hits: { $lt: Date } };
        $set: { updatedAt: Date };
        $setOnInsert: { userId: ObjectId; key: string };
      },
    ) => {
      if (!doc) {
        doc = {
          userId: filter.userId,
          key: filter.key,
          hits: [],
          updatedAt: update.$set.updatedAt,
        };
      }
      const windowStart = update.$pull.hits.$lt;
      doc.hits = doc.hits.filter((h) => h >= windowStart);
      doc.updatedAt = update.$set.updatedAt;
      return { ...doc, hits: [...doc.hits] };
    },
  ),
  updateOne: vi.fn(
    async (_filter: unknown, update: { $push: { hits: Date } }) => {
      doc?.hits.push(update.$push.hits);
    },
  ),
};

vi.mock("../db/client", () => ({
  getDb: vi.fn(async () => ({})),
  getClient: () => Promise.resolve({}),
  DB_NAME: "claudius",
}));
vi.mock("../db/collections", () => ({
  rateLimitsCol: vi.fn(async () => fakeCol),
}));

const { checkRateLimit } = await import("./slidingWindow");

describe("checkRateLimit", () => {
  const userId = new ObjectId();
  const opts = { limit: 3, windowMs: 1000 };
  const t0 = new Date("2026-07-01T00:00:00.000Z");

  beforeEach(() => {
    doc = null;
    vi.clearAllMocks();
  });

  it("allows up to the limit then denies within the window", async () => {
    const at = (ms: number): Date => new Date(t0.getTime() + ms);
    expect((await checkRateLimit(userId, "chat", opts, at(0))).allowed).toBe(true);
    expect((await checkRateLimit(userId, "chat", opts, at(10))).allowed).toBe(true);
    expect((await checkRateLimit(userId, "chat", opts, at(20))).allowed).toBe(true);
    const fourth = await checkRateLimit(userId, "chat", opts, at(30));
    expect(fourth.allowed).toBe(false);
    expect(fourth.retryAfterMs).toBeGreaterThan(0);
  });

  it("reports remaining budget as it counts down", async () => {
    const first = await checkRateLimit(userId, "chat", opts, t0);
    expect(first.remaining).toBe(2);
  });

  it("slides: once the window passes, requests are allowed again", async () => {
    const at = (ms: number): Date => new Date(t0.getTime() + ms);
    await checkRateLimit(userId, "chat", opts, at(0));
    await checkRateLimit(userId, "chat", opts, at(10));
    await checkRateLimit(userId, "chat", opts, at(20));
    expect((await checkRateLimit(userId, "chat", opts, at(30))).allowed).toBe(false);
    // 1100ms later the first three hits have aged out of the 1000ms window.
    expect((await checkRateLimit(userId, "chat", opts, at(1100))).allowed).toBe(true);
  });
});
