import { qualifiedName, referenceOfIn, type NamedInstances, type NormalizedSchema, type TransientObject } from "@scfloworg/core";
import { DEFAULT_SEPARATOR, formatList } from "./cells.js";
import { layoutOf, splitQualified, type ColumnSpec } from "./layout.js";
import { loadContext, loadIndex, sheetNames, sheetSchemas, shortName } from "./model.js";
import { SpreadsheetError, type CellValue, type ExportOptions, type ExportResult, type Row, type Sheet, type Skipped, type SpreadsheetDataset } from "./types.js";

/** The value of the property of `spec` in a stored instance, a facet value being nested under the namespace of its facet. */
export function readValue(instance: TransientObject, spec: ColumnSpec): unknown {
  if (spec.facet === undefined) return instance[spec.property.name];
  const { namespace, short } = splitQualified(spec.property.name);
  const nested = instance[namespace];
  if (nested !== null && typeof nested === "object" && !Array.isArray(nested)) return (nested as TransientObject)[short];
  return instance[spec.property.name];
}

/** The cell of one column for a stored instance. */
function cellOf(instance: TransientObject, spec: ColumnSpec, all: NamedInstances, languages: readonly string[], separator: string, where: string): CellValue {
  const value = readValue(instance, spec);
  if (value === undefined || value === null) return null;
  switch (spec.kind) {
    case "relation":
      return typeof value === "string" && value !== "" ? referenceOfIn(all, value, languages).reference : null;
    case "localized": {
      const text = (value as Record<string, unknown>)[spec.language as string];
      return typeof text === "string" && text !== "" ? text : null;
    }
    case "list":
      return Array.isArray(value) ? formatList(value as CellValue[], separator, `${where}, column "${spec.header}"`) : null;
    default:
      return typeof value === "string" ? (value === "" ? null : value) : (value as CellValue);
  }
}

/**
 * Exports a dataset to sheets: one per entity type that is referred to by
 * name, one row per instance, sorted by qualified name. The columns are the
 * properties of the schema, `name` first; a relation is written as the
 * reference of its target, a localized property has one column per language
 * of the dataset (the first is the source language), a facet adds its columns.
 * No id is written. What cannot be written in a cell is listed in `skipped`.
 */
export async function exportSheets(dataset: SpreadsheetDataset, options: ExportOptions = {}): Promise<ExportResult> {
  const { model, languages } = await loadContext(dataset);
  const separator = options.listSeparator ?? DEFAULT_SEPARATOR;
  const all = await loadIndex(dataset, model);
  const skipped: Skipped[] = [];

  let schemas: NormalizedSchema[] = sheetSchemas(model);
  const titles = sheetNames(schemas);
  if (options.schemas) {
    const wanted = options.schemas;
    for (const name of wanted) {
      if (!schemas.some((s) => s.name === name || shortName(s.name) === name)) {
        throw new SpreadsheetError("unknown_sheet", `no schema "${name}" is referred to by name: ${schemas.map((s) => titles.get(s.name)).join(", ")}`);
      }
    }
    schemas = schemas.filter((s) => wanted.includes(s.name) || wanted.includes(shortName(s.name)));
  }
  for (const schema of model.schemas.values()) {
    if (!schemas.includes(schema) && !options.schemas && schema.constraints.abstract !== true && schema.constraints.embedded !== true && schema.constraints.facet_of === undefined && schema.constraints.singleton !== true) {
      skipped.push({ schema: schema.name, reason: "it has no name_scope: its instances have no name to write a reference or a key with" });
    }
  }

  const sheets: Sheet[] = [];
  for (const schema of schemas) {
    const layout = layoutOf(model, schema, languages);
    skipped.push(...layout.skipped);
    const instances = (await dataset.query({ query: schema.name } as never)).after as TransientObject[];
    const named = instances
      .map((instance) => ({ instance, found: all.get(instance.id as string) }))
      .filter((entry): entry is { instance: TransientObject; found: NonNullable<typeof entry.found> } => entry.found !== undefined && entry.found.schema === schema.name)
      .map((entry) => ({ ...entry, sort: qualifiedName(entry.found, all, languages) }))
      .sort((a, b) => (a.sort < b.sort ? -1 : a.sort > b.sort ? 1 : 0));
    const rows: Row[] = named.map(({ instance, sort }) => {
      const row: Row = {};
      for (const spec of layout.columns) row[spec.header] = cellOf(instance, spec, all, languages, separator, `${titles.get(schema.name)} "${sort}"`);
      return row;
    });
    sheets.push({ name: titles.get(schema.name) as string, schema: schema.name, columns: layout.columns.map((c) => c.header), rows });
  }
  return { sheets, languages, skipped };
}
