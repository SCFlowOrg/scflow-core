import { modelError } from "./errors.js";

/** The `language_code` scalar type: a language, optionally with a region (en, fr, pt-BR). */
const LANGUAGE_CODE = /^[a-z]{2}(-[A-Z]{2})?$/;

/**
 * Checks the `languages` of a dataset (packages/core/docs/spec/meta-model.md#dataset, *Languages*):
 * an array of `language_code`, none twice. Returns a copy of the list.
 * Throws `constraint_violation` otherwise.
 */
export function validateLanguages(value: unknown): string[] {
  if (!Array.isArray(value)) throw modelError("constraint_violation", `"languages" must be an array of language codes`);
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || !LANGUAGE_CODE.test(item)) {
      throw modelError("constraint_violation", `"languages" holds "${String(item)}", which is not a language_code`);
    }
    if (seen.has(item)) throw modelError("constraint_violation", `"languages" lists "${item}" twice`);
    seen.add(item);
  }
  return [...value] as string[];
}

/** The `languages` of a dataset record: `[]` (not stated) when absent. */
export function languagesOf(dataset: { languages?: unknown } | null | undefined): string[] {
  return Array.isArray(dataset?.languages) ? (dataset.languages as string[]) : [];
}

/**
 * Reads a localized text (`localized_string`, `localized_markdown`) for the
 * language `preferred`: its own entry, else its base language (`pt-BR` falls
 * back to `pt`), else the first language of `languages` (the source language)
 * with the same two steps. Returns `undefined` when none is present. Entries
 * outside `languages` are read like any other: the list never forbids.
 */
export function resolveLocalizedText(
  text: Record<string, string> | null | undefined,
  languages: readonly string[],
  preferred?: string,
): string | undefined {
  if (!text) return undefined;
  const pick = (language: string | undefined): string | undefined => {
    if (!language) return undefined;
    if (Object.prototype.hasOwnProperty.call(text, language)) return text[language];
    const base = language.split("-")[0];
    return base !== language && Object.prototype.hasOwnProperty.call(text, base) ? text[base] : undefined;
  };
  return pick(preferred) ?? pick(languages[0]);
}
