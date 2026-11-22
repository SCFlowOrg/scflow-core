import {
  buildDatasetModel,
  facetOfProperty,
  hasNameScope,
  isEmbedded,
  loadNamedInstances,
  type DatasetModel,
  type ModuleManifest,
  type NamedInstances,
  type NormalizedSchema,
  type PersistenceInterface,
  type TransientObject,
  type AuthoredCommand,
} from "@scfloworg/core";
import type { SpreadsheetDataset } from "./types.js";

/** The model of the dataset and its languages: everything a sheet is derived from. */
export interface Context {
  model: DatasetModel;
  /** The languages of the dataset, the first being the source language; `["en"]` when it states none. */
  languages: string[];
}

/**
 * Reads the model of the installed modules from the dump of the dataset, which
 * embeds each manifest, and its languages from the dataset record. Nothing is
 * specific to a module: every sheet is derived from these schemas.
 */
export async function loadContext(dataset: SpreadsheetDataset): Promise<Context> {
  const dump = JSON.parse(await dataset.dump("json")) as { model?: Record<string, ModuleManifest> };
  const model = buildDatasetModel(Object.values(dump.model ?? {}));
  const info = (await dataset.info()) as { languages?: unknown };
  const languages = Array.isArray(info.languages) ? info.languages.filter((l): l is string => typeof l === "string") : [];
  return { model, languages: languages.length > 0 ? languages : ["en"] };
}

/** A schema a sheet exists for: stored, and not a base to extend only, a facet or a singleton. */
export function isSheetSchema(schema: NormalizedSchema): boolean {
  return !isEmbedded(schema) && schema.constraints.abstract !== true && schema.constraints.facet_of === undefined && schema.constraints.singleton !== true;
}

/** The schemas with a sheet, in the order of the model. */
export function sheetSchemas(model: DatasetModel): NormalizedSchema[] {
  return [...model.schemas.values()].filter(isSheetSchema);
}

/**
 * How a row of a sheet is found again among the instances of its schema: by its
 * `name` in its scope when the schema has a `name_scope`; else by the values of
 * the first `unique` group it declares; else by the values of all its own
 * properties, so that a row equal to an instance is that instance.
 */
export type EntityKey =
  | { kind: "name" }
  | { kind: "group"; name: string; properties: string[] }
  | { kind: "values"; properties: string[] };

/** The key of the rows of `schema`, see `EntityKey`. */
export function keyOf(schema: NormalizedSchema): EntityKey {
  if (hasNameScope(schema)) return { kind: "name" };
  const groups = Array.isArray(schema.constraints.unique) ? (schema.constraints.unique as unknown as { name: string; properties: string[] }[]) : [];
  if (groups.length > 0) return { kind: "group", name: groups[0].name, properties: groups[0].properties };
  const own = schema.properties.filter(
    (p) => p.constraints.__generated !== true && p.constraints.is_array !== true && p.name !== "id" && !p.name.includes(".") && facetOfProperty(p) === undefined,
  );
  return { kind: "values", properties: own.map((p) => p.name) };
}

/** `target` and the schemas that extend it, transitively, that have a sheet: what a relation to `target` can point at. */
export function candidatesOf(model: DatasetModel, target: NormalizedSchema): NormalizedSchema[] {
  const names = [target.name];
  for (let i = 0; i < names.length; i++) {
    for (const s of model.schemas.values()) if (s.extends === names[i] && !names.includes(s.name)) names.push(s.name);
  }
  return names.map((n) => model.schemas.get(n) as NormalizedSchema).filter(isSheetSchema);
}

/** The short name of a qualified schema name: `scflow.actor` gives `actor`. */
export const shortName = (qualified: string): string => qualified.slice(qualified.indexOf(".") + 1);

/** The title of the sheet of each schema: its short name, qualified when two schemas share it. */
export function sheetNames(schemas: readonly NormalizedSchema[]): Map<string, string> {
  const count = new Map<string, number>();
  for (const s of schemas) count.set(shortName(s.name), (count.get(shortName(s.name)) ?? 0) + 1);
  return new Map(schemas.map((s) => [s.name, (count.get(shortName(s.name)) ?? 0) > 1 ? s.name : shortName(s.name)]));
}

/** Reads every named instance through `query`, as the engine's own resolver does. */
export async function loadIndex(dataset: SpreadsheetDataset, model: DatasetModel): Promise<NamedInstances> {
  const resolvers = { schemas: model.schemas, importNamespaces: [] } as never;
  const impl = {
    listInstances: async (_rest: string, schema: string) =>
      (await dataset.query({ query: schema } as AuthoredCommand)).after as TransientObject[],
  } as unknown as PersistenceInterface;
  return loadNamedInstances(impl, "", resolvers);
}
