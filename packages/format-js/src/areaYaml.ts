import { readFile } from "node:fs/promises";
import { load as loadYaml } from "js-yaml";
import type { Key, TransientValue } from "@scfloworg/core";
import type { DatasetRecord, DatasetState } from "./inMemory.js";

/**
 * Node-only fallback that reads an area's built-in dataset from a YAML file.
 * Internal to the package: this is the only module importing
 * `node:fs/promises` and `js-yaml`, which keeps the browser entry point free
 * of both. The Node entry point passes `resolveAreaYamlState` to
 * `createJsPersistenceInterfaceCore` as its `diskFallback`.
 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The parts of a `dumpDataset` file that an area's built-in dataset reads:
 * `dataset`, `schemas` and `scalar_types`. `imports` and `data` are ignored
 * because a built-in dataset holds a model only.
 */
interface ParsedAreaDump {
  dataset: DatasetRecord;
  schemas: Record<string, TransientValue>;
  scalar_types: Record<string, TransientValue>;
}

/**
 * Reads and parses the YAML file at `path` as an area's built-in dataset.
 *
 * The file is read on every call and never cached, so an edit on disk shows
 * on the next call.
 *
 * @param path - filesystem path of the YAML file.
 * @returns the parsed dump, or `null` when the file is missing, is not valid
 * YAML, or lacks a `dataset.name` string and `schemas` and `scalar_types`
 * objects. Never throws.
 */
export async function readAreaYaml(path: string): Promise<ParsedAreaDump | null> {
  let text: string;
  try {
    text = await readFile(path, "utf-8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = loadYaml(text);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  const { dataset, schemas, scalar_types } = parsed;
  if (!isPlainObject(dataset) || typeof dataset.name !== "string") return null;
  if (!isPlainObject(schemas)) return null;
  if (!isPlainObject(scalar_types)) return null;
  return {
    dataset: dataset as unknown as DatasetRecord,
    schemas: schemas as Record<string, TransientValue>,
    scalar_types: scalar_types as Record<string, TransientValue>,
  };
}

/** Builds a throwaway, read-only `DatasetState` from a parsed area-dump file. */
function stateFromAreaDump(dump: ParsedAreaDump): DatasetState {
  const schemaStore: Map<Key, TransientValue> = new Map(Object.entries(dump.schemas));
  const scalarTypeStore: Map<Key, TransientValue> = new Map(Object.entries(dump.scalar_types));
  return {
    info: dump.dataset,
    stores: new Map([
      ["schema", schemaStore],
      ["scalar_type", scalarTypeStore],
    ]),
  };
}

/**
 * Resolves `rest` as the filesystem path of an area's built-in YAML dump.
 *
 * @param rest - the area of a locator, used as a file path.
 * @returns a throwaway read-only dataset state, or `null` when `readAreaYaml`
 * finds nothing usable at that path.
 */
export async function resolveAreaYamlState(rest: string): Promise<DatasetState | null> {
  const dump = await readAreaYaml(rest);
  return dump ? stateFromAreaDump(dump) : null;
}
