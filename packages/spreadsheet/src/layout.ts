import {
  facetOfProperty,
  isEmbedded,
  resolveType,
  type DatasetModel,
  type NormalizedProperty,
  type NormalizedSchema,
} from "@scfloworg/core";
import { candidatesOf } from "./model.js";
import type { Skipped } from "./types.js";

/** The pattern of a language code, which the key of a localized property follows. */
const LANGUAGE_PATTERN = "^[a-z]{2}(-[A-Z]{2})?$";

/** How a column holds the value of its property. */
export type ColumnKind = "text" | "list" | "relation" | "localized";

/** The base type of a scalar column. */
export type Base = "string" | "number" | "integer" | "boolean";

/** One column of a sheet: a property, and the language when the property is localized. */
export interface ColumnSpec {
  header: string;
  property: NormalizedProperty;
  kind: ColumnKind;
  /** The type of the values of a `text` or `list` column. */
  base?: Base;
  /** The language of a `localized` column. */
  language?: string;
  /** The schema a `relation` column points at, and the schemas with a sheet it can point at: it and those that extend it. */
  target?: NormalizedSchema;
  candidates?: NormalizedSchema[];
  /** The qualified name of the facet that adds the property, when one does. */
  facet?: string;
}

export interface Layout {
  schema: NormalizedSchema;
  columns: ColumnSpec[];
  skipped: Skipped[];
}

/** The header of a localized column. */
export const localizedHeader = (property: string, language: string): string => `${property} (${language})`;

/**
 * The columns of the sheet of `schema`: its properties in the order of the
 * schema, `name` first, each as one column, or one column per language for a
 * localized property. A property that cannot be written in a cell is left
 * out, with the reason: a generated inverse relation, an owned embedded schema, a map that is not a text by
 * language.
 */
export function layoutOf(model: DatasetModel, schema: NormalizedSchema, languages: readonly string[]): Layout {
  const ctx = { resolveSchema: (n: string) => model.schemas.get(n), resolveScalarType: (n: string) => model.scalarTypes.get(n) };
  const skipped: Skipped[] = [];
  const skip = (property: string, reason: string) => skipped.push({ schema: schema.name, property, reason });
  const columns: ColumnSpec[] = [];
  const properties = [...schema.properties].sort((a, b) => Number(b.name === "name") - Number(a.name === "name"));
  for (const property of properties) {
    if (property.constraints.__generated === true || property.name === "id") continue;
    const facet = facetOfProperty(property);
    const base = { property, ...(facet !== undefined ? { facet } : {}) };
    let resolved;
    try {
      resolved = resolveType(property.type, ctx);
    } catch {
      skip(property.name, `its type "${property.type}" is unknown`);
      continue;
    }
    if (resolved.kind === "relation") {
      const target = resolved.schema;
      const candidates = candidatesOf(model, target);
      if (isEmbedded(target)) skip(property.name, `it holds "${target.name}" instances nested in the entity, which a cell cannot hold`);
      else if (candidates.length === 0) skip(property.name, `"${target.name}" has no instance a sheet can hold`);
      else columns.push({ ...base, header: property.name, kind: "relation", target, candidates });
      continue;
    }
    if (resolved.kind === "map") {
      if (resolved.key.constraints.pattern === LANGUAGE_PATTERN && resolved.value.base === "string") {
        for (const language of languages) columns.push({ ...base, header: localizedHeader(property.name, language), kind: "localized", language });
      } else skip(property.name, "it is a map that is not a text by language");
      continue;
    }
    const list = property.constraints.is_array === true;
    columns.push({ ...base, header: property.name, kind: list ? "list" : "text", base: resolved.base });
  }
  return { schema, columns, skipped };
}

/** The qualified names of the namespace and the short name of a facet or a schema: `carbon.co2_info` gives `carbon` and `co2_info`. */
export function splitQualified(name: string): { namespace: string; short: string } {
  const dot = name.indexOf(".");
  return { namespace: name.slice(0, dot), short: name.slice(dot + 1) };
}
