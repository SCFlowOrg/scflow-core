/**
 * Turns the value of a text parameter into a localized map.
 *
 * A plain string `s` becomes `{ en: s }`, because an action receives no active
 * language. A map of language to string is returned as a copy. The registry has
 * checked the value against `localizedTextParam`.
 *
 * @param value The value of the parameter, a string or a map of language to string.
 * @returns The localized map, never empty.
 */
export function toLocalized(value: string | Record<string, string>): Record<string, string> {
  return typeof value === "string" ? { en: value } : { ...value };
}
