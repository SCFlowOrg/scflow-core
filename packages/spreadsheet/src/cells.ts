import type { Base } from "./layout.js";
import { SpreadsheetError, type CellValue } from "./types.js";

export const DEFAULT_SEPARATOR = ";";

/** Whether a cell holds nothing: no value, or only spaces. */
export const isBlank = (cell: CellValue | undefined): boolean => cell === null || cell === undefined || (typeof cell === "string" && cell.trim() === "");

/** The cell of a list: its values joined by the separator and a space. */
export function formatList(values: readonly CellValue[], separator: string, what: string): CellValue {
  if (values.length === 0) return null;
  const texts = values.map((v) => String(v));
  const clash = texts.find((t) => t.includes(separator));
  if (clash !== undefined) {
    throw new SpreadsheetError("separator_in_value", `${what}: the value ${JSON.stringify(clash)} contains the list separator ${JSON.stringify(separator)}; choose another separator`);
  }
  return texts.join(separator.endsWith(" ") ? separator : `${separator} `);
}

/** The values of the cell of a list: the text split on the separator, trimmed, empty parts dropped. */
export function splitList(cell: CellValue, separator: string): string[] {
  if (isBlank(cell)) return [];
  return String(cell)
    .split(separator)
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

/** The value a cell gives for a scalar of type `base`, or a message for a cell that is not one. */
export function parseScalar(cell: CellValue, base: Base): { value: string | number | boolean } | { error: string } {
  if (base === "string") return { value: typeof cell === "string" ? cell : String(cell) };
  if (base === "boolean") {
    if (typeof cell === "boolean") return { value: cell };
    const text = String(cell).trim().toLowerCase();
    if (text === "true") return { value: true };
    if (text === "false") return { value: false };
    return { error: `${JSON.stringify(cell)} is not a boolean (true or false)` };
  }
  const number = typeof cell === "number" ? cell : typeof cell === "string" && cell.trim() !== "" ? Number(cell.trim()) : Number.NaN;
  if (!Number.isFinite(number)) return { error: `${JSON.stringify(cell)} is not a number` };
  if (base === "integer" && !Number.isInteger(number)) return { error: `${JSON.stringify(cell)} is not an integer` };
  return { value: number };
}

/** A value of a property as the instance holds it, when two values are the same. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => sameValue(v, b[i]));
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const x = Object.entries(a as Record<string, unknown>);
    const y = b as Record<string, unknown>;
    return x.length === Object.keys(y).length && x.every(([k, v]) => sameValue(v, y[k]));
  }
  return a === b;
}
