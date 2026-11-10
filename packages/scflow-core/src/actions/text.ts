import type { ActionAccess } from "./params.js";

/**
 * Turns the value of a text parameter into a localized map.
 *
 * A plain string `s` becomes `{ [language]: s }`, because an action receives no
 * active language: `language` is the source language of the dataset, `en` when
 * the dataset states none. A map of language to string is returned as a copy.
 * The registry has checked the value against `localizedTextParam`.
 *
 * @param value The value of the parameter, a string or a map of language to string.
 * @param language The language of a plain string, `en` by default.
 * @returns The localized map, never empty.
 */
export function toLocalized(value: string | Record<string, string>, language = "en"): Record<string, string> {
  return typeof value === "string" ? { [language]: value } : { ...value };
}

/**
 * `toLocalized` for an action body: a plain string is written in the source
 * language of the dataset, the first of its `languages` (see `languages` of
 * `dataset` in `packages/core/docs/spec/meta-model.md`), `en` when none is
 * stated. A map is not looked up, so it costs no read.
 */
export async function localizedText(
  context: ActionAccess,
  value: string | Record<string, string>,
): Promise<Record<string, string>> {
  if (typeof value !== "string") return toLocalized(value);
  const { after } = await context.runCommand(context.locator, { kind: "query", schema: "dataset" });
  // The bundle of a module imports nothing, so the list is read here, not through `languagesOf` of the core.
  const languages = (after[0] as { languages?: unknown } | undefined)?.languages;
  const source = Array.isArray(languages) && typeof languages[0] === "string" ? languages[0] : undefined;
  return toLocalized(value, source);
}
