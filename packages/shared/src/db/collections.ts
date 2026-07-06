import type { Collection } from "mongodb";
import { getDb } from "./client";
import type {
  Chunk,
  Conversation,
  DocumentRecord,
  Job,
  Memory,
  RateLimit,
  SearchCacheEntry,
  Settings,
  UsageEvent,
  User,
} from "./schemas";

/**
 * Typed accessors for every collection. Centralizing the names here (rather
 * than sprinkling string literals across the codebase) means a rename happens
 * in one place, and every accessor returns a `Collection<T>` so the
 * "filter by userId" invariant is visible to the type checker at each call site.
 */
export const COLLECTIONS = {
  users: "users",
  conversations: "conversations",
  memories: "memories",
  documents: "documents",
  chunks: "chunks",
  usageEvents: "usage_events",
  settings: "settings",
  rateLimits: "rate_limits",
  jobs: "jobs",
  // Phase 8: the tiered answer-engine cache. GLOBAL and content-only — no
  // userId, no user data — so it is safely shared across users (see
  // SearchCacheEntrySchema). Entries reap on a per-doc TTL.
  searchCache: "search_cache",
} as const;

export async function usersCol(): Promise<Collection<User>> {
  return (await getDb()).collection<User>(COLLECTIONS.users);
}

export async function conversationsCol(): Promise<Collection<Conversation>> {
  return (await getDb()).collection<Conversation>(COLLECTIONS.conversations);
}

export async function memoriesCol(): Promise<Collection<Memory>> {
  return (await getDb()).collection<Memory>(COLLECTIONS.memories);
}

export async function documentsCol(): Promise<Collection<DocumentRecord>> {
  return (await getDb()).collection<DocumentRecord>(COLLECTIONS.documents);
}

export async function chunksCol(): Promise<Collection<Chunk>> {
  return (await getDb()).collection<Chunk>(COLLECTIONS.chunks);
}

export async function usageEventsCol(): Promise<Collection<UsageEvent>> {
  return (await getDb()).collection<UsageEvent>(COLLECTIONS.usageEvents);
}

export async function settingsCol(): Promise<Collection<Settings>> {
  return (await getDb()).collection<Settings>(COLLECTIONS.settings);
}

export async function rateLimitsCol(): Promise<Collection<RateLimit>> {
  return (await getDb()).collection<RateLimit>(COLLECTIONS.rateLimits);
}

export async function jobsCol(): Promise<Collection<Job>> {
  return (await getDb()).collection<Job>(COLLECTIONS.jobs);
}

export async function searchCacheCol(): Promise<Collection<SearchCacheEntry>> {
  return (await getDb()).collection<SearchCacheEntry>(COLLECTIONS.searchCache);
}
