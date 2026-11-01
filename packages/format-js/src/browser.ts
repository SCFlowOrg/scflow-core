import { createJsPersistenceInterfaceCore } from "./inMemory.js";
import type { PersistenceInterface } from "@scfloworg/core";

/**
 * Creates a `js` persistence interface with its own empty dataset registry,
 * for a browser bundle: nothing this entry point imports touches `node:fs` or
 * `js-yaml`.
 *
 * The area's built-in dataset has no YAML fallback here. Reading a built-in
 * rest answers "no dataset" (`datasetExists` is false, the other reads throw
 * `dataset_not_found`) until a dataset was created at that rest in memory.
 * `areaOf` and `builtinRestFor` are the same pure string functions as on the
 * Node entry point.
 *
 * @param name - the format prefix the interface answers to; defaults to `"js"`.
 * @returns a `PersistenceInterface` whose registry is shared with no other
 * instance.
 */
export function createJsPersistenceInterface(name = "js"): PersistenceInterface {
  return createJsPersistenceInterfaceCore(name);
}

/** A shared `js` interface, created once with the default name `"js"`. */
export const jsFormat = createJsPersistenceInterface();

/** `jsFormat` under the export name `--format-module` loaders read. */
export const format = jsFormat;
