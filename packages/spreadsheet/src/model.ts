import {
  buildDatasetModel,
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

/** A schema a sheet exists for: referred to by name, stored, and not a base to extend only. */
export function isSheetSchema(schema: NormalizedSchema): boolean {
  return hasNameScope(schema) && !isEmbedded(schema) && schema.constraints.abstract !== true && schema.constraints.facet_of === undefined;
}

/** The schemas with a sheet, in the order of the model. */
export function sheetSchemas(model: DatasetModel): NormalizedSchema[] {
  return [...model.schemas.values()].filter(isSheetSchema);
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
