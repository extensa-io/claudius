import { z } from "zod";

/**
 * `quote_cache` backs Phase 13 quote mode. A `$` lookup hits a metered
 * market-data provider, and the same few tickers get asked repeatedly, so this
 * store is what keeps a free provider tier viable.
 *
 * INVARIANT #1 by construction: GLOBAL and CONTENT-ONLY, exactly like
 * `search_cache` and `dictionary_cache`. The key and value carry NO `userId` and
 * NO user-specific content — only a public price. Two members quoting MDB share
 * the entry and neither can infer the other's activity, so there is nothing
 * user-owned here to guard.
 *
 * The value is the provider's DATA, not a rendered block, because an FX rate is
 * independent of the amount asked about: `$500 CAD to COP` and `$20 CAD to COP`
 * must share one cached rate. Rendering happens after the read.
 *
 * `expiresAt` is session-aware rather than fixed (see quoteTtlSeconds): seconds
 * while the market is open, half an hour once it has closed and the price cannot
 * move. Reaped by the same per-document TTL pattern as the other two caches.
 */

const InstrumentValueSchema = z.object({
  kind: z.literal("instrument"),
  name: z.string().optional(),
  currency: z.string().optional(),
  price: z.number(),
  /** The previous close (or the 24h-ago point); null when unavailable. */
  reference: z.number().nullable(),
  marketOpen: z.boolean(),
  /** ISO-8601; a string so the cached value round-trips through JSON cleanly. */
  asOf: z.string(),
});

const RateValueSchema = z.object({
  kind: z.literal("rate"),
  rate: z.number(),
  reference: z.number().nullable(),
  marketOpen: z.boolean(),
  asOf: z.string(),
});

export const QuoteValueSchema = z.discriminatedUnion("kind", [
  InstrumentValueSchema,
  RateValueSchema,
]);

/** The cached payload. Single type source for the store and the renderers. */
export type QuoteValue = z.infer<typeof QuoteValueSchema>;

export const QuoteCacheEntrySchema = z.object({
  _id: z.string(), // the content hash — see quotes.ts quoteCacheKey()
  value: QuoteValueSchema,
  createdAt: z.date(),
  expiresAt: z.date(),
});

export type QuoteCacheEntry = z.infer<typeof QuoteCacheEntrySchema>;
