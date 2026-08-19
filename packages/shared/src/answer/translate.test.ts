import { describe, expect, it } from "vitest";
import {
  MemoryTranslationCacheStore,
  TRANSLATE_LANG_CODES,
  buildTranslateMessages,
  parseTranslateQuery,
  translateLangName,
  translationCacheKey,
} from "./translate";

/**
 * Translate mode (Phase 14) — the runtime-agnostic core: parsing the `&`
 * operator in its three forms, the prompt builder, the cache key, and the
 * in-memory store. Pure functions, tested directly.
 */

describe("parseTranslateQuery", () => {
  it("recognizes the coded form with an auto-detected source", () => {
    expect(parseTranslateQuery("&it good morning")).toEqual({
      text: "good morning",
      source: null,
      target: "it",
    });
    expect(parseTranslateQuery("&it buenos dias")).toEqual({
      text: "buenos dias",
      source: null,
      target: "it",
    });
  });

  it("recognizes the explicit source>target form", () => {
    expect(parseTranslateQuery("&es>it buenos dias")).toEqual({
      text: "buenos dias",
      source: "es",
      target: "it",
    });
    expect(parseTranslateQuery("&pt>fr obrigado")).toEqual({
      text: "obrigado",
      source: "pt",
      target: "fr",
    });
  });

  it("treats a bare `&` (space after) as targeting English", () => {
    expect(parseTranslateQuery("& buon giorno")).toEqual({
      text: "buon giorno",
      source: null,
      target: "en",
    });
    expect(parseTranslateQuery("&   guten Tag  ")).toEqual({
      text: "guten Tag",
      source: null,
      target: "en",
    });
  });

  // The whole reason the space is load-bearing: `es`, `it`, `de`, and `el` are
  // also common function words in the supported languages, so the two forms
  // must not be allowed to collapse into each other.
  it("distinguishes `&es text` from `& es text`", () => {
    expect(parseTranslateQuery("&es importante")).toEqual({
      text: "importante",
      source: null,
      target: "es",
    });
    expect(parseTranslateQuery("& es importante")).toEqual({
      text: "es importante",
      source: null,
      target: "en",
    });
    expect(parseTranslateQuery("& el niño duerme")).toEqual({
      text: "el niño duerme",
      source: null,
      target: "en",
    });
  });

  it("accepts every supported code as a target and as a source", () => {
    for (const code of TRANSLATE_LANG_CODES) {
      expect(parseTranslateQuery(`&${code} hello`)?.target).toBe(code);
      const other = TRANSLATE_LANG_CODES.find((c) => c !== code)!;
      expect(parseTranslateQuery(`&${code}>${other} hello`)).toEqual({
        text: "hello",
        source: code,
        target: other,
      });
    }
  });

  it("is case-insensitive on the codes", () => {
    expect(parseTranslateQuery("&IT good morning")?.target).toBe("it");
    expect(parseTranslateQuery("&ES>IT buenos dias")).toEqual({
      text: "buenos dias",
      source: "es",
      target: "it",
    });
  });

  it("rejects an unsupported code on either side", () => {
    expect(parseTranslateQuery("&ja konnichiwa")).toBeNull();
    expect(parseTranslateQuery("&ja>en konnichiwa")).toBeNull();
    expect(parseTranslateQuery("&en>ja hello")).toBeNull();
  });

  it("rejects the same code on both sides", () => {
    expect(parseTranslateQuery("&es>es hola")).toBeNull();
  });

  it("rejects `&&`, a bare `&`, and a code with no text", () => {
    expect(parseTranslateQuery("&&it good morning")).toBeNull();
    expect(parseTranslateQuery("&")).toBeNull();
    expect(parseTranslateQuery("&   ")).toBeNull();
    expect(parseTranslateQuery("&it")).toBeNull();
    expect(parseTranslateQuery("&it   ")).toBeNull();
  });

  it("rejects `&` glued to something that is not a code", () => {
    expect(parseTranslateQuery("&hello world")).toBeNull();
    expect(parseTranslateQuery("&foo>bar baz")).toBeNull();
    expect(parseTranslateQuery("&en>es>it hello")).toBeNull();
  });

  it("leaves a mid-sentence `&` and other operators alone", () => {
    expect(parseTranslateQuery("rock & roll history")).toBeNull();
    expect(parseTranslateQuery("?ephemeral")).toBeNull();
    expect(parseTranslateQuery("!gh langgraph")).toBeNull();
    expect(parseTranslateQuery("$MDB")).toBeNull();
  });

  it("falls through past the length cap so `&` is not a cheap chat route", () => {
    expect(parseTranslateQuery(`&it ${"a".repeat(501)}`)).toBeNull();
    expect(parseTranslateQuery(`&it ${"a".repeat(400)}`)).not.toBeNull();
  });
});

describe("buildTranslateMessages", () => {
  it("tells the model to detect the source in the auto form", () => {
    const { system, human } = buildTranslateMessages({
      text: "good morning",
      source: null,
      target: "it",
    });
    expect(system).toContain("Detect the source language");
    expect(system).toContain("Italian");
    expect(human).toContain("good morning");
  });

  it("asserts the source in the explicit form", () => {
    const { system } = buildTranslateMessages({
      text: "buenos dias",
      source: "es",
      target: "it",
    });
    expect(system).toContain("Treat the input as Spanish");
    expect(system).not.toContain("Detect the source language");
  });

  it("lists the other supported languages in the footer, never the target", () => {
    const { system } = buildTranslateMessages({
      text: "hello",
      source: null,
      target: "de",
    });
    expect(system).toContain("el (Greek)");
    expect(system).not.toContain("de (German)");
  });

  it("carries the Greek transliteration and German formality rules", () => {
    const { system } = buildTranslateMessages({
      text: "good morning",
      source: null,
      target: "el",
    });
    expect(system).toContain("Latin transliteration");
    expect(system).toContain("du/Sie");
  });
});

describe("translationCacheKey", () => {
  it("is stable across trivial input differences", () => {
    expect(translationCacheKey("Good Morning", null, "it")).toBe(
      translationCacheKey("  good   morning ", null, "it"),
    );
  });

  it("separates directions", () => {
    const a = translationCacheKey("buenos dias", null, "it");
    const b = translationCacheKey("buenos dias", null, "fr");
    const c = translationCacheKey("buenos dias", "es", "it");
    expect(new Set([a, b, c]).size).toBe(3);
  });
});

describe("translateLangName", () => {
  it("names every supported code", () => {
    expect(translateLangName("el")).toBe("Greek");
    expect(translateLangName("pt")).toBe("Portuguese");
  });
});

describe("MemoryTranslationCacheStore", () => {
  it("round-trips a value and expires it", async () => {
    let now = 0;
    const store = new MemoryTranslationCacheStore(() => now);
    const value = {
      markdown: "## buon giorno",
      sourceLang: "auto" as const,
      targetLang: "it" as const,
    };
    await store.set("k", value, 60);
    expect(await store.get("k")).toEqual(value);
    now = 61_000;
    expect(await store.get("k")).toBeNull();
  });
});
