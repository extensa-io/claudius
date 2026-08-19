/**
 * The languages the `&` translate operator supports, declared once.
 *
 * This lives in its OWN dependency-free module, apart from `translate.ts`, for
 * the same reason `documents/constants.ts` does: the `/help` cheat sheet lists
 * these codes and is imported by a CLIENT component, while `translate.ts`
 * reaches for the Mongo-backed cache and can never ship to a browser. Splitting
 * the table out lets both sides read one source of truth — the parser and the
 * prompt builder on the server, the help text on the client — without dragging
 * the driver into the bundle.
 *
 * Adding a language is a one-line edit here and nowhere else.
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

export function isTranslateLang(code: string): code is TranslateLang {
  return Object.hasOwn(TRANSLATE_LANGUAGES, code);
}

/** A language's full name, for prompts and rendered copy. */
export function translateLangName(lang: TranslateLang): string {
  return TRANSLATE_LANGUAGES[lang];
}
