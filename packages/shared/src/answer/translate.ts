import { createHash } from "node:crypto";
import { translationCacheCol } from "../db/collections";
import type { TranslationCacheEntry } from "../db/schemas";

/**
 * Translate mode (Phase 14): a leading `&` is an explicit translation operator.
 * `&it good morning` and `&it buenos dias` both return "buon giorno" plus the
 * register and usage notes that make a translation usable rather than merely
 * correct. A bare `& text` targets English, the common case when reading
 * something foreign.
 *
 * No external translation service. DeepL, AWS Translate, and friends return a
 * string and nothing else; the notes ARE the feature here, and they need a model
 * call regardless — so routing through a translation API would mean paying twice
 * and adding a network hop for a marginally different literal string. Source
 * language detection is part of the same call for the same reason, which is why
 * this module has no equivalent of dictionary.ts's `detectLanguage` heuristic.
 *
 * Like dictionary.ts this is the runtime-agnostic core: pure parsing, the prompt
 * builder (plain strings, so no LangChain dependency leaks in), and a global,
 * content-only cache. The app layer wires it into the chat route.
 */

/**
 * The supported languages, declared once. The parser, the prompt builder, and
 * the help text all read this, so adding a language is a one-line edit here.
 */
export const TRANSLATE_LANGUAGES = {
  en: "English",
  es: "Spanish",
  it: "Italian",
  pt: "Portuguese",
  fr: "French",
  de: "German",
  el: "Greek",
} as const;

export type TranslateLang = keyof typeof TRANSLATE_LANGUAGES;

/** The bare `&` form's target. Reading something foreign is the common case. */
export const DEFAULT_TARGET_LANG: TranslateLang = "en";

export const TRANSLATE_LANG_CODES = Object.keys(
  TRANSLATE_LANGUAGES,
) as TranslateLang[];

function isTranslateLang(code: string): code is TranslateLang {
  return Object.hasOwn(TRANSLATE_LANGUAGES, code);
}

/** A translation's full name, for prompts and rendered copy. */
export function translateLangName(lang: TranslateLang): string {
  return TRANSLATE_LANGUAGES[lang];
}

// A sentence or two is a legitimate translation; a document is not. Beyond this
// many characters we fall through to normal chat so `&` never becomes a cheaper
// back door into the chat turn. Characters rather than words because the same
// sentence varies wildly in word count across these seven languages.
const MAX_TRANSLATE_CHARS = 500;

export interface TranslateQuery {
  /** The text to translate. */
  text: string;
  /** The asserted source language, or null when the model should detect it. */
  source: TranslateLang | null;
  /** The target language. Never null — the bare form resolves to English. */
  target: TranslateLang;
}

/**
 * Recognize a translate-query. Three forms:
 *   `&it text`      — explicit target, source auto-detected
 *   `&es>it text`   — explicit source and target
 *   `& text`        — bare: target English, source auto-detected
 *
 * Returns null when the input is not a translate, so it falls through to normal
 * chat: a doubled `&&`, an unsupported code on either side, the same code on
 * both sides, no text at all, text past the length cap, and `&` glued to
 * something that isn't a language code (`&hello world`).
 */
export function parseTranslateQuery(raw: string): TranslateQuery | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("&") || trimmed.startsWith("&&")) return null;

  const rest = trimmed.slice(1);

  // THE SPACE IS LOAD-BEARING. Several supported codes are also common function
  // words in the other supported languages, so `&es importante` (target Spanish)
  // and `& es importante` (translate that Spanish into English) must not be
  // allowed to collapse into each other. A space right after `&` means the bare
  // form, full stop — the coded form is never valid with one.
  if (/^\s/.test(rest)) {
    const text = rest.trim();
    if (text.length === 0 || text.length > MAX_TRANSLATE_CHARS) return null;
    return { text, source: null, target: DEFAULT_TARGET_LANG };
  }

  // Coded form: the prefix runs up to the first whitespace.
  const match = /^(\S+)\s+([\s\S]+)$/.exec(rest);
  const prefix = match?.[1];
  const body = match?.[2];
  if (prefix === undefined || body === undefined) return null;

  const text = body.trim();
  if (text.length === 0 || text.length > MAX_TRANSLATE_CHARS) return null;

  const parts = prefix.toLowerCase().split(">");

  if (parts.length === 1) {
    const target = parts[0];
    if (target === undefined || !isTranslateLang(target)) return null;
    return { text, source: null, target };
  }

  if (parts.length === 2) {
    const [source, target] = parts;
    if (source === undefined || target === undefined) return null;
    if (!isTranslateLang(source) || !isTranslateLang(target)) return null;
    // `&es>es` asks for nothing; treat it as a non-translate rather than
    // burning a gated model call to echo the input back.
    if (source === target) return null;
    return { text, source, target };
  }

  return null;
}

export interface TranslatePromptMessages {
  system: string;
  human: string;
}

/**
 * Build the translate prompt. Returns plain strings so the app constructs the
 * LangChain messages (this module stays LangChain-free). When `source` is null
 * the model detects and reports it; when it is set the model treats it as
 * authoritative, which is the whole point of the `&es>it` form.
 */
export function buildTranslateMessages(
  query: TranslateQuery,
): TranslatePromptMessages {
  const { text, source, target } = query;
  const targetName = translateLangName(target);
  const otherCodes = TRANSLATE_LANG_CODES.filter((c) => c !== target);
  const others = otherCodes
    .map((c) => `${c} (${translateLangName(c)})`)
    .join(", ");
  // Spelled out as a fill-in-the-blanks template rather than described, because
  // a described format drifts between runs and the entries then look unrelated.
  const footerTemplate = otherCodes.map((c) => `${c} *…*`).join(" · ");

  // Built here rather than described in the prompt. A described format ("the
  // target language, then the source") drifts between models: a stronger model
  // read "<target name>" as the name of the TRANSLATION and echoed the answer
  // back into the metadata line. Everything except the detected source is known
  // at build time, so hand over the finished line and leave only the blank.
  const metaLine = `**${targetName}** · from **${
    source === null ? "<the source language you detected>" : translateLangName(source)
  }** "${text}"`;

  const sourceDirective =
    source === null
      ? "Detect the source language of the input yourself and state what you detected."
      : `Treat the input as ${translateLangName(source)} — the user asserted this, so do not second-guess it.`;

  const system = `You translate short text into ${targetName}, and you explain what a bare translation cannot. ${sourceDirective}

Answer in Markdown, in this shape:
- An H2 heading that is the translation itself, and nothing else.
- One line beneath it, which is EXACTLY this and nothing else: \`${metaLine}\`
- Alternate renderings, on their own line as \`Also: ...\`, whenever a second natural form exists — a one-word or hyphenated variant, a more common spelling, a regional preference, a shorter colloquial form. Look for one before deciding there is none; most phrases have one. Omit the line only when there genuinely is not.
- A short bulleted list of usage notes, only where they change how the phrase should be used: register and formality, gender or number differences from the source, whether the reading is literal or idiomatic, and any time-of-day, regional, or social constraint that would make the phrase wrong in context. Two to four bullets. Do not pad — omit a bullet rather than state the obvious.
- A final one-line footer, with no horizontal rule above it, giving the same phrase in each of the remaining supported languages — ${others} — filling in this exact template: \`**Other:** ${footerTemplate}\`

Language-specific requirements:
- A Greek translation ALWAYS carries a Latin transliteration alongside the Greek script, in both the heading and the footer, because the reader may not read the alphabet.
- A German translation notes the du/Sie formality split whenever the phrase is one where it matters.

If the text is ALREADY in ${targetName}, say so plainly in one line instead of echoing it back as a translation, then give the usage notes and the other-languages footer as normal.

Write the notes in ${targetName}. No preamble, no meta-commentary, no offer to help further — just the entry.`;

  const human = `Translate into ${targetName}: ${text}`;

  return { system, human };
}

// --- Cache ----------------------------------------------------------------
//
// GLOBAL and CONTENT-ONLY, exactly like the Phase 8 search cache and the Phase
// 10 dictionary cache: the key is a hash of the normalized text + direction, the
// value is the public translation entry, and neither carries a `userId` or any
// user-specific content. Two users translating the same phrase share the entry
// (invariant #1 holds because there is nothing user-owned to guard).

/** Evergreen: a translation of a fixed phrase is stable. */
export const TRANSLATION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

export interface TranslationValue {
  markdown: string;
  /** The resolved source: the asserted code, or `auto` when it was detected. */
  sourceLang: TranslateLang | "auto";
  targetLang: TranslateLang;
}

export interface TranslationCacheStore {
  get(key: string): Promise<TranslationValue | null>;
  set(key: string, value: TranslationValue, ttlSeconds: number): Promise<void>;
}

/** Normalize so trivially different inputs share one entry. Content-only. */
function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * The cache key: a stable SHA-256 over the normalized text + direction, doubling
 * as the Mongo `_id`. The auto form keys on `auto` rather than on the detected
 * source, because the detected source is not known until the call has already
 * happened — so `&it buenos dias` and `&es>it buenos dias` are separate buckets
 * even though they produce the same answer. Deduplicating them would need a
 * second lookup after the model returns, which is not worth it at this volume.
 */
export function translationCacheKey(
  text: string,
  source: TranslateLang | null,
  target: TranslateLang,
): string {
  const canonical = JSON.stringify({
    t: normalizeText(text),
    s: source ?? "auto",
    d: target,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/** In-process L1: a bounded Map with per-entry expiry checked on read. */
export class MemoryTranslationCacheStore implements TranslationCacheStore {
  private readonly map = new Map<
    string,
    { value: TranslationValue; expiresAtMs: number }
  >();

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly maxEntries = 500,
  ) {}

  async get(key: string): Promise<TranslationValue | null> {
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
    value: TranslationValue,
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
export class MongoTranslationCacheStore implements TranslationCacheStore {
  constructor(private readonly now: () => number = () => Date.now()) {}

  async get(key: string): Promise<TranslationValue | null> {
    const col = await translationCacheCol();
    const doc = await col.findOne({
      _id: key,
      expiresAt: { $gt: new Date(this.now()) },
    });
    if (!doc) return null;
    return {
      markdown: doc.markdown,
      sourceLang: doc.sourceLang,
      targetLang: doc.targetLang,
    };
  }

  async set(
    key: string,
    value: TranslationValue,
    ttlSeconds: number,
  ): Promise<void> {
    if (ttlSeconds <= 0) return;
    const col = await translationCacheCol();
    const entry: TranslationCacheEntry = {
      _id: key,
      markdown: value.markdown,
      sourceLang: value.sourceLang,
      targetLang: value.targetLang,
      createdAt: new Date(this.now()),
      expiresAt: new Date(this.now() + ttlSeconds * 1000),
    };
    const { _id, ...rest } = entry;
    await col.updateOne({ _id }, { $set: rest }, { upsert: true });
  }
}

/** Two-tier read-through store: L1 (memory) in front of L2 (Mongo). */
export class TieredTranslationCacheStore implements TranslationCacheStore {
  constructor(
    private readonly l1: TranslationCacheStore,
    private readonly l2: TranslationCacheStore,
  ) {}

  async get(key: string): Promise<TranslationValue | null> {
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
    value: TranslationValue,
    ttlSeconds: number,
  ): Promise<void> {
    await Promise.all([
      this.l1.set(key, value, ttlSeconds),
      this.l2.set(key, value, ttlSeconds),
    ]);
  }
}

/** The process-wide default store: memory L1 + Mongo L2. Constructed once. */
let defaultStore: TranslationCacheStore | null = null;
export function getDefaultTranslationCacheStore(): TranslationCacheStore {
  defaultStore ??= new TieredTranslationCacheStore(
    new MemoryTranslationCacheStore(),
    new MongoTranslationCacheStore(),
  );
  return defaultStore;
}
