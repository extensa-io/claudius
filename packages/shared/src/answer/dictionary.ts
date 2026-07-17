import { createHash } from "node:crypto";
import { dictionaryCacheCol } from "../db/collections";
import type { DictionaryCacheEntry } from "../db/schemas";

/**
 * Dictionary mode (Phase 10): a leading `?` is an explicit define/translate
 * operator. `?fishy` defines a word; `?bang for your buck` explains an idiom.
 * Either way the entry auto-detects the source language (English or Spanish) and
 * gives the translation into the other.
 *
 * This module is the runtime-agnostic core: pure parsing, a cheap language
 * heuristic, the prompt builder (plain strings, so no LangChain dependency leaks
 * in), and a global/content-only cache. The app layer wires it into the chat
 * route and streams the model. It sits beside the search answer engine as the
 * second "engine" behind `/api/chat`.
 */

export type DictLang = "en" | "es";

/** The other language — the translation target. */
export function otherLang(lang: DictLang): DictLang {
  return lang === "en" ? "es" : "en";
}

// A short phrase is fine (idioms, collocations); a full sentence is not a
// lookup. Beyond this many words we fall through to normal chat so `?` never
// becomes a cheaper back door into the chat turn.
const MAX_DEFINE_WORDS = 6;

/**
 * Recognize a define-query: a single leading ASCII `?` followed by a term or
 * short phrase. Returns the trimmed term, or null when the input is not a
 * define. A trailing `?` (a normal question) and a leading `¿` (a Spanish
 * question) are deliberately NOT defines; a bare `?` is not a define; and a long
 * sentence falls through so the path stays a lookup.
 */
export function parseDefineQuery(raw: string): string | null {
  const trimmed = raw.trim();
  // Exactly one leading `?`, then real content. `??` or `? ` alone don't count.
  if (!trimmed.startsWith("?") || trimmed.startsWith("??")) return null;

  const term = trimmed.slice(1).trim();
  if (term.length === 0) return null;

  // A sentence is not a lookup. Count whitespace-separated tokens.
  const words = term.split(/\s+/);
  if (words.length > MAX_DEFINE_WORDS) return null;

  return term;
}

// Spanish-only signals. Any hit flips detection to Spanish; the default is
// English (the app's primary language) when nothing Spanish-specific appears.
// Cheap and explainable on purpose — it only has to pick the cache-key
// direction, and the prompt tells the model to verify the language itself.
const SPANISH_CHARS = /[áéíóúñü¿¡]/i;
const SPANISH_WORDS = new Set([
  "el",
  "la",
  "los",
  "las",
  "un",
  "una",
  "unos",
  "unas",
  "de",
  "del",
  "y",
  "o",
  "que",
  "qué",
  "por",
  "para",
  "con",
  "sin",
  "es",
  "su",
  "al",
]);

/**
 * Detect whether a term is Spanish or English. Diacritics / `ñ` / inverted
 * punctuation are decisive; otherwise a Spanish function word in a phrase flips
 * it; otherwise default to English. Ambiguous single tokens spelled the same in
 * both languages (e.g. "final", "no") resolve to English — the prompt still
 * detects the true language at generation time, so only the cache bucket is
 * affected.
 */
export function detectLanguage(term: string): DictLang {
  if (SPANISH_CHARS.test(term)) return "es";
  const words = term.toLowerCase().split(/\s+/);
  if (words.some((w) => SPANISH_WORDS.has(w))) return "es";
  return "en";
}

const LANG_NAME: Record<DictLang, string> = {
  en: "English",
  es: "Spanish",
};

export interface DictionaryPromptMessages {
  system: string;
  human: string;
}

/**
 * Build the dictionary prompt. Returns plain strings so the app constructs the
 * LangChain messages (this module stays LangChain-free). The `sourceLang` hint
 * comes from the heuristic; the prompt tells the model to confirm it, so a
 * mis-detected word is still explained in its real language.
 */
export function buildDictionaryMessages(
  term: string,
  sourceLang: DictLang,
): DictionaryPromptMessages {
  const source = LANG_NAME[sourceLang];
  const target = LANG_NAME[otherLang(sourceLang)];

  const system = `You are a precise bilingual English–Spanish dictionary. The user gives a single word or a short phrase. Detect its language (it is most likely ${source}; verify, and if it is actually ${target} treat that as the source and translate the other way). Produce a detailed dictionary entry in Markdown, written in the source language, with a translation section in the other language.

For a single word, include:
- The headword with its part of speech and a pronunciation hint (IPA or a simple phonetic respelling).
- Numbered senses when the word has more than one meaning, each with a concise definition and 2–3 natural example sentences in the source language.
- A short list of synonyms and antonyms, and a one-line note on register (formal, informal, slang, regional).

For a phrase or idiom, adapt: skip part of speech and IPA; explain the meaning, whether it is literal or figurative, its register, and give 2–3 example sentences.

End with a "Translation" section: the equivalent word or idiom in the other language, and 1–2 of the example sentences translated. Keep it tight and useful — no preamble, no meta-commentary, just the entry.`;

  const human = `Define and translate: ${term}`;

  return { system, human };
}

// --- Cache ----------------------------------------------------------------
//
// GLOBAL and CONTENT-ONLY, exactly like the Phase 8 search cache: the key is a
// hash of the normalized term + direction, the value is the public dictionary
// entry, and neither carries a `userId` or any user-specific content. Two users
// looking up the same word share the entry (invariant #1 holds because there is
// nothing user-owned to guard). It lives in its OWN collection because the value
// is a structured Markdown entry, not a `SearchResult[]`.
//
// Definitions are evergreen — a word's meaning doesn't churn — so there is one
// long TTL rather than the intent-aware tiers the search cache needs.

/** Evergreen: a definition is stable, so cache it for a long time. */
export const DICTIONARY_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

export interface DictionaryValue {
  markdown: string;
  sourceLang: DictLang;
}

export interface DictionaryCacheStore {
  get(key: string): Promise<DictionaryValue | null>;
  set(key: string, value: DictionaryValue, ttlSeconds: number): Promise<void>;
}

/** Normalize a term so trivially different inputs share one entry: trim,
 * collapse whitespace, lowercase. Content-only — no user data enters the key. */
function normalizeTerm(term: string): string {
  return term.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * The cache key: a stable SHA-256 over the normalized term + direction, so
 * "final" (en) and "final" (es) are distinct buckets. Doubles as the Mongo
 * `_id`, so a read is a primary-key hit and a write an idempotent upsert.
 */
export function dictionaryCacheKey(term: string, sourceLang: DictLang): string {
  const canonical = JSON.stringify({ t: normalizeTerm(term), l: sourceLang });
  return createHash("sha256").update(canonical).digest("hex");
}

/** In-process L1: a bounded Map with per-entry expiry checked on read. */
export class MemoryDictionaryCacheStore implements DictionaryCacheStore {
  private readonly map = new Map<
    string,
    { value: DictionaryValue; expiresAtMs: number }
  >();

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly maxEntries = 500,
  ) {}

  async get(key: string): Promise<DictionaryValue | null> {
    const hit = this.map.get(key);
    if (!hit) return null;
    if (hit.expiresAtMs <= this.now()) {
      this.map.delete(key);
      return null;
    }
    return hit.value;
  }

  async set(
    key: string,
    value: DictionaryValue,
    ttlSeconds: number,
  ): Promise<void> {
    if (ttlSeconds <= 0) return;
    if (this.map.size >= this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, { value, expiresAtMs: this.now() + ttlSeconds * 1000 });
  }
}

/**
 * MongoDB-backed L2. Reads honor `expiresAt` in the query (belt-and-suspenders
 * against the TTL monitor's lag), so a just-expired entry is never served before
 * the reaper deletes it. Writes upsert by `_id` (the key).
 */
export class MongoDictionaryCacheStore implements DictionaryCacheStore {
  constructor(private readonly now: () => number = () => Date.now()) {}

  async get(key: string): Promise<DictionaryValue | null> {
    const col = await dictionaryCacheCol();
    const doc = await col.findOne({
      _id: key,
      expiresAt: { $gt: new Date(this.now()) },
    });
    if (!doc) return null;
    return { markdown: doc.markdown, sourceLang: doc.sourceLang };
  }

  async set(
    key: string,
    value: DictionaryValue,
    ttlSeconds: number,
  ): Promise<void> {
    if (ttlSeconds <= 0) return;
    const col = await dictionaryCacheCol();
    const entry: DictionaryCacheEntry = {
      _id: key,
      markdown: value.markdown,
      sourceLang: value.sourceLang,
      createdAt: new Date(this.now()),
      expiresAt: new Date(this.now() + ttlSeconds * 1000),
    };
    const { _id, ...rest } = entry;
    await col.updateOne({ _id }, { $set: rest }, { upsert: true });
  }
}

/** Two-tier read-through store: L1 (memory) in front of L2 (Mongo). */
export class TieredDictionaryCacheStore implements DictionaryCacheStore {
  constructor(
    private readonly l1: DictionaryCacheStore,
    private readonly l2: DictionaryCacheStore,
  ) {}

  async get(key: string): Promise<DictionaryValue | null> {
    const fromL1 = await this.l1.get(key);
    if (fromL1) return fromL1;
    const fromL2 = await this.l2.get(key);
    if (fromL2) {
      // Re-warm L1 with a short default; L2 stays the source of truth on expiry.
      await this.l1.set(key, fromL2, 5 * 60);
      return fromL2;
    }
    return null;
  }

  async set(
    key: string,
    value: DictionaryValue,
    ttlSeconds: number,
  ): Promise<void> {
    await Promise.all([
      this.l1.set(key, value, ttlSeconds),
      this.l2.set(key, value, ttlSeconds),
    ]);
  }
}

/** The process-wide default store: memory L1 + Mongo L2. Constructed once. */
let defaultStore: DictionaryCacheStore | null = null;
export function getDefaultDictionaryCacheStore(): DictionaryCacheStore {
  defaultStore ??= new TieredDictionaryCacheStore(
    new MemoryDictionaryCacheStore(),
    new MongoDictionaryCacheStore(),
  );
  return defaultStore;
}
