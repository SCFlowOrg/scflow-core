import { qualifiedName, type NormalizedSchema, type TransientObject } from "@scfloworg/core";
import { Catalog, loadCatalog } from "./catalog.js";
import { DEFAULT_SEPARATOR, formatList } from "./cells.js";
import { layoutOf, splitQualified, type ColumnSpec } from "./layout.js";
import { keyOf, loadContext, sheetNames, sheetSchemas, shortName } from "./model.js";
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
function cellOf(instance: TransientObject, spec: ColumnSpec, catalog: Catalog, separator: string, where: string): CellValue {
  const value = readValue(instance, spec);
  if (value === undefined || value === null) return null;
  switch (spec.kind) {
    case "relation":
      return typeof value === "string" && value !== "" ? catalog.referenceIn(value, spec.candidates ?? []) : null;
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
  const { catalog, stored } = await loadCatalog(dataset, model, languages);
  const all = catalog.named;
  const skipped: Skipped[] = [];

  let schemas: NormalizedSchema[] = sheetSchemas(model);
  const titles = sheetNames(schemas);
  if (options.schemas) {
    const wanted = options.schemas;
    for (const name of wanted) {
      if (!schemas.some((s) => s.name === name || shortName(s.name) === name)) {
        throw new SpreadsheetError("unknown_sheet", `no schema "${name}" has a sheet: ${schemas.map((s) => titles.get(s.name)).join(", ")}`);
      }
    }
    schemas = schemas.filter((s) => wanted.includes(s.name) || wanted.includes(shortName(s.name)));
  }

  const sheets: Sheet[] = [];
  for (const schema of schemas) {
    const layout = layoutOf(model, schema, languages);
    skipped.push(...layout.skipped);
    const instances = stored.get(schema.name) as TransientObject[];
    const rows: Row[] = instances
      .filter((instance) => keyOf(schema).kind !== "name" || all.get(instance.id as string)?.schema === schema.name)
      .map((instance) => ({ instance, sort: keyOf(schema).kind === "name" ? qualifiedName(all.get(instance.id as string) as never, all, languages) : catalog.labelOf(instance.id as string) }))
      .sort((a, b) => (a.sort < b.sort ? -1 : a.sort > b.sort ? 1 : 0))
      .map(({ instance, sort }) => {
        const row: Row = {};
        for (const spec of layout.columns) row[spec.header] = cellOf(instance, spec, catalog, separator, `${titles.get(schema.name)} "${sort}"`);
        return row;
      });
    sheets.push({ name: titles.get(schema.name) as string, schema: schema.name, columns: layout.columns.map((c) => c.header), rows });
  }
  return { sheets, languages, skipped };
}
