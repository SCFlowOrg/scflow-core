/**
 * Test helper for business packages: an open document with the given schemas,
 * reached through the same filtered `MclAccess` the plugin hands out.
 */
import { createCoreRuntime, type CoreRuntime } from "./index.js";
import type { SchemaPackage } from "./types.js";

let counter = 0;

export async function createTestDocument(
  schemas: SchemaPackage | Record<string, unknown>[],
): Promise<{ runtime: CoreRuntime; mcl: CoreRuntime["mcl"]; locator: string; docId: string }> {
  counter += 1;
  const runtime = createCoreRuntime({ area: `test${counter}` });
  await runtime.init();
  await runtime.registerSchemas("test", schemas);
  const docId = `doc${counter}`;
  const locator = await runtime.createDocument(docId);
  return { runtime, mcl: runtime.mcl, locator, docId };
}
