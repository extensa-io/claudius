import { describe, expect, it } from "vitest";
import {
  cacheKey,
  MemoryCacheStore,
  TieredCacheStore,
  ttlForIntent,
  type CacheStore,
  type CacheValue,
} from "./cache";
import type { SearchResult } from "./types";

/**
 * Tiered cache (Phase 8). The in-memory store and the pure key/TTL helpers are
 * tested here without a database; the Mongo store's query shape is covered by the
 * engine integration test. The invariant-#1 property (global, content-only key)
 * is asserted directly: the key is a function of query + intent + source params
 * ONLY, so no userId can enter it.
 */

const results: SearchResult[] = [
  { title: "t", url: "https://e.com/1", snippet: "s" },
];
const value: CacheValue = { results, source: "brave", intent: "informational" };

describe("cacheKey", () => {
  it("is stable across whitespace/case normalization of the query", () => {
    const a = cacheKey({ query: "What is  X", intent: "informational", highValue: false, maxResults: 5 });
    const b = cacheKey({ query: "what is x", intent: "informational", highValue: false, maxResults: 5 });
    expect(a).toBe(b);
  });

  it("differs by intent, highValue, and maxResults", () => {
    const base = { query: "x", intent: "informational" as const, highValue: false, maxResults: 5 };
    expect(cacheKey(base)).not.toBe(cacheKey({ ...base, intent: "transactional" }));
    expect(cacheKey(base)).not.toBe(cacheKey({ ...base, highValue: true }));
    expect(cacheKey(base)).not.toBe(cacheKey({ ...base, maxResults: 10 }));
  });

  it("is content-only: two users issuing the same query produce the same key", () => {
    // There is no userId parameter to pass — the type itself forbids it, so the
    // key cannot encode who asked. Same query ⇒ same key ⇒ a shared entry.
    const k1 = cacheKey({ query: "shared question", intent: "informational", highValue: false, maxResults: 5 });
    const k2 = cacheKey({ query: "shared question", intent: "informational", highValue: false, maxResults: 5 });
    expect(k1).toBe(k2);
  });
});

describe("ttlForIntent", () => {
  const ttls = { freshSeconds: 60, evergreenSeconds: 600, transactionalSeconds: 120 };
  it("never caches navigational", () => {
    expect(ttlForIntent("navigational", false, ttls)).toBe(0);
  });
  it("picks fresh vs evergreen for informational", () => {
    expect(ttlForIntent("informational", true, ttls)).toBe(60);
    expect(ttlForIntent("informational", false, ttls)).toBe(600);
  });
  it("uses the short churn TTL for transactional", () => {
    expect(ttlForIntent("transactional", false, ttls)).toBe(120);
  });
});

describe("MemoryCacheStore", () => {
  it("returns a stored value before its TTL and null after", async () => {
    let now = 1_000_000;
    const store = new MemoryCacheStore(() => now);
    await store.set("k", value, 60); // 60s TTL
    expect(await store.get("k")).toEqual(value);
    now += 59_000;
    expect(await store.get("k")).toEqual(value); // still fresh
    now += 2_000;
    expect(await store.get("k")).toBeNull(); // expired (news-like reap)
  });

  it("does not store a zero TTL (navigational)", async () => {
    const store = new MemoryCacheStore(() => 0);
    await store.set("k", value, 0);
    expect(await store.get("k")).toBeNull();
  });

  it("evicts the oldest entry past the size cap", async () => {
    const store = new MemoryCacheStore(() => 0, 2);
    await store.set("a", value, 60);
    await store.set("b", value, 60);
    await store.set("c", value, 60); // evicts "a"
    expect(await store.get("a")).toBeNull();
    expect(await store.get("c")).toEqual(value);
  });
});

describe("TieredCacheStore", () => {
  it("serves from L1, falls back to L2 and promotes to L1", async () => {
    const l1 = new MemoryCacheStore(() => 0);
    // A fake L2 that records reads so we can prove L1 shields it after promotion.
    let l2reads = 0;
    const l2: CacheStore = {
      async get(key) {
        l2reads++;
        return key === "k" ? value : null;
      },
      async set() {},
    };
    const tiered = new TieredCacheStore(l1, l2);

    // First read misses L1, hits L2 (1 read), promotes to L1.
    expect(await tiered.get("k")).toEqual(value);
    expect(l2reads).toBe(1);
    // Second read is served by L1 — L2 not touched again.
    expect(await tiered.get("k")).toEqual(value);
    expect(l2reads).toBe(1);
  });

  it("writes through to both layers", async () => {
    const l1 = new MemoryCacheStore(() => 0);
    let l2set = 0;
    const l2: CacheStore = {
      async get() {
        return null;
      },
      async set() {
        l2set++;
      },
    };
    const tiered = new TieredCacheStore(l1, l2);
    await tiered.set("k", value, 60);
    expect(l2set).toBe(1);
    expect(await l1.get("k")).toEqual(value);
  });
});
