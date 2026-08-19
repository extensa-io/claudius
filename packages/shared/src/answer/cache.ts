import { createHash } from "node:crypto";
import { searchCacheCol } from "../db/collections";
import type { CacheTtls, SearchCacheEntry } from "../db/schemas";
import { DEFAULT_CACHE_TTLS } from "./defaults";
import type { Intent, SearchIntent, SearchResult, SearchSource } from "./types";

/**
 * The tiered answer-engine cache (Phase 8).
 *
 * GLOBAL and CONTENT-ONLY by design: the key is a hash of the normalized query +
 * intent + source params, and the value is the public search results. Neither
 * carries a `userId` or any user-specific content, so the cache is shared safely
 * across users and can never become a cross-user inference vector (invariant #1
 * holds precisely because there is nothing user-owned in the store).
 *
 * Two layers behind one `CacheStore` interface:
 *   - L1: an in-process `Map` — absorbs bursts within a warm serverless instance
 *     for free, and is the whole store in tests.
 *   - L2: MongoDB `search_cache` — survives across instances/regions, reaped by a
 *     per-doc TTL index on `expiresAt` (news-like minutes vs. evergreen weeks).
 *
 * TTLs are intent-aware: navigational is never cached (it resolves to a URL with
 * no round trip); informational picks fresh vs. evergreen from the `fresh` hint;
 * transactional gets the short churn TTL.
 */

export interface CacheKeyParts {
  query: string;
  intent: SearchIntent;
  /** Depth signal — a high-value (Tavily advanced) result must not be served to
   * a plain request and vice versa, so it is part of the key. */
  highValue: boolean;
  /** Soft result cap the request asked for — different caps are different values. */
  maxResults: number | undefined;
}

export interface CacheValue {
  results: SearchResult[];
  source: SearchSource;
  intent: SearchIntent;
}

export interface CacheStore {
  get(key: string): Promise<CacheValue | null>;
  set(key: string, value: CacheValue, ttlSeconds: number): Promise<void>;
}

/** Normalize a query so trivially different phrasings share one entry: trim,
 * collapse whitespace, lowercase. Content-only — no user data enters the key. */
function normalizeQuery(query: string): string {
  return query.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * The cache key: a stable SHA-256 over the normalized query + intent + source
 * params. Deterministic and collision-resistant, and it doubles as the Mongo
 * document `_id`, so an L2 read is a primary-key hit and a write is an idempotent
 * upsert.
 */
export function cacheKey(parts: CacheKeyParts): string {
  const canonical = JSON.stringify({
    q: normalizeQuery(parts.query),
    i: parts.intent,
    hv: parts.highValue,
    n: parts.maxResults ?? null,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Pick the TTL (seconds) for an entry from its intent and a freshness hint.
 * Navigational returns 0 (never cache); the caller skips caching on 0.
 */
export function ttlForIntent(
  intent: Intent,
  fresh: boolean,
  ttls: CacheTtls = DEFAULT_CACHE_TTLS,
): number {
  switch (intent) {
    case "navigational":
      return 0;
    // Phase 10: a lexical (`?` dictionary) query is served by the dictionary
    // path with its OWN cache and never reaches the search cache, so it has no
    // TTL here. Return 0 (never cache) defensively.
    case "lexical":
      return 0;
    // Phase 13: likewise, a `$` market query is served by the quote path with its
    // own session-aware cache and never reaches the search cache.
    case "market":
      return 0;
    // Phase 14: likewise, a `&` translate query is served by the translate path
    // with its own evergreen cache and never reaches the search cache.
    case "lingual":
      return 0;
    case "transactional":
      return ttls.transactionalSeconds;
    case "informational":
      return fresh ? ttls.freshSeconds : ttls.evergreenSeconds;
  }
}

/** In-process L1: a bounded Map with per-entry expiry checked on read. */
export class MemoryCacheStore implements CacheStore {
  private readonly map = new Map<string, { value: CacheValue; expiresAtMs: number }>();

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly maxEntries = 500,
  ) {}

  async get(key: string): Promise<CacheValue | null> {
    const hit = this.map.get(key);
    if (!hit) return null;
    if (hit.expiresAtMs <= this.now()) {
      this.map.delete(key);
      return null;
    }
    return hit.value;
  }

  async set(key: string, value: CacheValue, ttlSeconds: number): Promise<void> {
    if (ttlSeconds <= 0) return;
    // Simple size guard: drop the oldest inserted entry when full. This is a
    // burst absorber, not a durable store (that is L2), so exact LRU isn't worth
    // the bookkeeping.
    if (this.map.size >= this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, { value, expiresAtMs: this.now() + ttlSeconds * 1000 });
  }
}

/**
 * MongoDB-backed L2. Reads honor `expiresAt` in the query (belt-and-suspenders
 * against the TTL monitor's lag), so a just-expired entry is never served even
 * before the background reaper deletes it. Writes upsert by `_id` (the key).
 */
export class MongoCacheStore implements CacheStore {
  constructor(private readonly now: () => number = () => Date.now()) {}

  async get(key: string): Promise<CacheValue | null> {
    const col = await searchCacheCol();
    const doc = await col.findOne({
      _id: key,
      expiresAt: { $gt: new Date(this.now()) },
    });
    if (!doc) return null;
    return { results: doc.results, source: doc.source, intent: doc.intent };
  }

  async set(key: string, value: CacheValue, ttlSeconds: number): Promise<void> {
    if (ttlSeconds <= 0) return;
    const col = await searchCacheCol();
    const createdAt = new Date(this.now());
    const expiresAt = new Date(this.now() + ttlSeconds * 1000);
    const entry: SearchCacheEntry = {
      _id: key,
      results: value.results,
      source: value.source,
      intent: value.intent,
      createdAt,
      expiresAt,
    };
    const { _id, ...rest } = entry;
    await col.updateOne({ _id }, { $set: rest }, { upsert: true });
  }
}

/**
 * Two-tier read-through store: L1 (memory) in front of L2 (Mongo). A read checks
 * L1, then L2 (populating L1 on an L2 hit); a write goes to both. This is the
 * store the engine uses in production; tests can inject a bare MemoryCacheStore.
 */
export class TieredCacheStore implements CacheStore {
  constructor(
    private readonly l1: CacheStore,
    private readonly l2: CacheStore,
  ) {}

  async get(key: string): Promise<CacheValue | null> {
    const fromL1 = await this.l1.get(key);
    if (fromL1) return fromL1;
    const fromL2 = await this.l2.get(key);
    if (fromL2) {
      // Re-populate L1 with the L2 TTL unknown here; use a short default so a hot
      // key stays warm without outliving its true expiry (L2 remains the source
      // of truth for correctness — it re-checks expiresAt on read).
      await this.l1.set(key, fromL2, 5 * 60);
      return fromL2;
    }
    return null;
  }

  async set(key: string, value: CacheValue, ttlSeconds: number): Promise<void> {
    await Promise.all([
      this.l1.set(key, value, ttlSeconds),
      this.l2.set(key, value, ttlSeconds),
    ]);
  }
}

/** The process-wide default store: memory L1 + Mongo L2. Constructed once. */
let defaultStore: CacheStore | null = null;
export function getDefaultCacheStore(): CacheStore {
  defaultStore ??= new TieredCacheStore(new MemoryCacheStore(), new MongoCacheStore());
  return defaultStore;
}
