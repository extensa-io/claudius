import { ObjectId } from "mongodb";
import { describe, expect, it } from "vitest";
import { ConversationSchema } from "./conversation";
import { SettingsSchema } from "./settings";
import { UsageEventSchema } from "./usageEvent";

describe("ConversationSchema", () => {
  it("accepts a member conversation without expiresAt", () => {
    const parsed = ConversationSchema.parse({
      userId: new ObjectId(),
      title: "First chat",
      modelId: "haiku",
      createdAt: new Date(),
      updatedAt: new Date(),
      archived: false,
    });
    expect(parsed.expiresAt).toBeUndefined();
  });

  it("accepts a guest conversation with expiresAt", () => {
    const expiresAt = new Date();
    const parsed = ConversationSchema.parse({
      userId: new ObjectId(),
      title: "Guest chat",
      modelId: "haiku",
      createdAt: new Date(),
      updatedAt: new Date(),
      archived: false,
      expiresAt,
    });
    expect(parsed.expiresAt).toEqual(expiresAt);
  });
});

describe("SettingsSchema", () => {
  it("discriminates the guest circuit breaker by _id", () => {
    const parsed = SettingsSchema.parse({
      _id: "guestCircuitBreaker",
      dailyCeilingUsd: 1,
      state: "open",
      trippedAt: null,
    });
    expect(parsed._id).toBe("guestCircuitBreaker");
  });
});

describe("UsageEventSchema", () => {
  it("nests dimensions under meta", () => {
    const parsed = UsageEventSchema.parse({
      meta: { userId: new ObjectId(), modelId: "haiku", purpose: "chat" },
      conversationId: null,
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      latencyMs: 120,
      timestamp: new Date(),
    });
    expect(parsed.meta.purpose).toBe("chat");
  });
});
