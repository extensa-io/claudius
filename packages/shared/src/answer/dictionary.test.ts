import { describe, expect, it } from "vitest";
import {
  MemoryDictionaryCacheStore,
  buildDictionaryMessages,
  detectLanguage,
  dictionaryCacheKey,
  otherLang,
  parseDefineQuery,
} from "./dictionary";

/**
 * Dictionary mode (Phase 10) — the runtime-agnostic core: parsing the `?`
 * operator, the language heuristic, the cache key, and the in-memory store.
 * Pure functions, tested directly.
 */

describe("parseDefineQuery", () => {
  it("recognizes a leading `?` word", () => {
    expect(parseDefineQuery("?fishy")).toBe("fishy");
    expect(parseDefineQuery("?  ephemeral  ")).toBe("ephemeral");
  });

  it("recognizes a leading `?` short phrase or idiom", () => {
    expect(parseDefineQuery("?bang for your buck")).toBe("bang for your buck");
  });

  it("is NOT triggered by a trailing `?` (a normal question)", () => {
    expect(parseDefineQuery("what is fishy?")).toBeNull();
    expect(parseDefineQuery("fishy?")).toBeNull();
  });

  it("is NOT triggered by a leading Spanish `¿` question", () => {
    expect(parseDefineQuery("¿qué es esto?")).toBeNull();
  });

  it("ignores a bare `?` or `??`", () => {
    expect(parseDefineQuery("?")).toBeNull();
    expect(parseDefineQuery("?   ")).toBeNull();
    expect(parseDefineQuery("??help")).toBeNull();
  });

  it("falls through when the input is a sentence, not a lookup", () => {
    expect(
      parseDefineQuery("?what is the meaning of life and the universe"),
    ).toBeNull();
  });
});

describe("detectLanguage", () => {
  it("detects Spanish from diacritics or ñ", () => {
    expect(detectLanguage("efímero")).toBe("es");
    expect(detectLanguage("mañana")).toBe("es");
  });

  it("detects Spanish from a function word in a phrase", () => {
    expect(detectLanguage("bola de cristal")).toBe("es");
  });

  it("defaults to English for a plain token", () => {
    expect(detectLanguage("ephemeral")).toBe("en");
    // Ambiguous spelling resolves to English (the prompt corrects at generation).
    expect(detectLanguage("final")).toBe("en");
  });

  it("otherLang flips the direction", () => {
    expect(otherLang("en")).toBe("es");
    expect(otherLang("es")).toBe("en");
  });
});

describe("buildDictionaryMessages", () => {
  it("names both directions and carries the term", () => {
    const { system, human } = buildDictionaryMessages("ephemeral", "en");
    expect(system).toContain("English");
    expect(system).toContain("Spanish");
    expect(human).toContain("ephemeral");
  });
});

describe("dictionaryCacheKey", () => {
  it("is stable across trivial input differences", () => {
    expect(dictionaryCacheKey("Ephemeral", "en")).toBe(
      dictionaryCacheKey("  ephemeral ", "en"),
    );
  });

  it("separates the two directions of the same spelling", () => {
    expect(dictionaryCacheKey("final", "en")).not.toBe(
      dictionaryCacheKey("final", "es"),
    );
  });
});

describe("MemoryDictionaryCacheStore", () => {
  it("stores and returns an entry within its TTL", async () => {
    const store = new MemoryDictionaryCacheStore();
    const key = dictionaryCacheKey("ephemeral", "en");
    await store.set(key, { markdown: "# ephemeral", sourceLang: "en" }, 60);
    expect(await store.get(key)).toEqual({
      markdown: "# ephemeral",
      sourceLang: "en",
    });
  });

  it("expires an entry past its TTL", async () => {
    let now = 1_000_000;
    const store = new MemoryDictionaryCacheStore(() => now);
    const key = dictionaryCacheKey("ephemeral", "en");
    await store.set(key, { markdown: "x", sourceLang: "en" }, 60);
    now += 61 * 1000;
    expect(await store.get(key)).toBeNull();
  });

  it("never stores a non-positive TTL", async () => {
    const store = new MemoryDictionaryCacheStore();
    const key = dictionaryCacheKey("ephemeral", "en");
    await store.set(key, { markdown: "x", sourceLang: "en" }, 0);
    expect(await store.get(key)).toBeNull();
  });
});
