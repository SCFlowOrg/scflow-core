/**
 * Turns the value of a text parameter into a localized map.
 *
 * A plain string `s` becomes `{ en: s }`, because an action receives no active
 * language. A map of language to string is returned as a copy.
 *
 * @param value The value of the parameter, a string or a map of language to string.
 * @param param The name of the parameter, quoted in the error message.
 * @returns The localized map, never empty.
 * @throws When the value is missing, empty, or neither a string nor a map of strings.
 */
export function toLocalized(value: unknown, param: string): Record<string, string> {
  if (typeof value === "string") {
    if (value.trim() === "") {
      throw new Error(`parameter "${param}": must not be empty`);
    }
    return { en: value };
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) {
      throw new Error(`parameter "${param}": must not be an empty map`);
    }
    for (const [language, text] of entries) {
      if (typeof text !== "string" || text.trim() === "") {
        throw new Error(`parameter "${param}": the text of language "${language}" must be a non-empty string`);
      }
    }
    return { ...(value as Record<string, string>) };
  }
  throw new Error(`parameter "${param}": expected a string or a map of language to string`);
}
