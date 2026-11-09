import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { processSchemaDescription, NO_ROLES } from "@scfloworg/core";
import { registerPersistentFormat, initDataset, runCommand } from "@scfloworg/core/testing";
import type { NormalizedSchema, TransientObject, TransientValue } from "@scfloworg/core";
import { createJsPersistenceInterface } from "../src/browser.js";

/**
 * Guards the bundler safety of `browser.ts` (and its only import,
 * `inMemory.ts`) must never import `node:fs`/`node:fs/promises`/`js-yaml`,
 * directly or transitively — a static import of either breaks any bundle
 * that loads this module at all, even if the area/built-in disk fallback is
 * never called. Reads the package's own source files rather than the
 * compiled output, so it fails fast when a Node import is added to either
 * module.
 */
describe("browser.ts — bundler safety", () => {
  const NODE_ONLY_IMPORT = /from\s+["'](node:fs|node:fs\/promises|js-yaml)["']/;

  it("has no node:fs/js-yaml import in browser.ts or inMemory.ts", () => {
    for (const file of ["browser.ts", "inMemory.ts"]) {
      const path = fileURLToPath(new URL(`../src/${file}`, import.meta.url));
      const text = readFileSync(path, "utf-8");
      expect(text, `${file} must not import node:fs or js-yaml`).not.toMatch(NODE_ONLY_IMPORT);
    }
  });
});

