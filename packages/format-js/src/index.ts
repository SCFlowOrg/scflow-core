import { createJsPersistenceInterfaceCore } from "./inMemory.js";
import type { PersistenceInterface } from "@scfloworg/core";

/**
 * Creates a `js` persistence interface with its own empty dataset registry.
 *
 * Datasets live in memory for the lifetime of the returned interface. This is
 * the Node entry point; a browser bundle imports `@scfloworg/format-js/browser`.
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

/**
 * `jsFormat` under the export name `--format-module` loaders read: a
 * persistent format module exports its `PersistenceInterface` as `format`.
 */
export const format = jsFormat;
