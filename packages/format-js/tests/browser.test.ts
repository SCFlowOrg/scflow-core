import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { registerPersistentFormat, initDataset, runCommand, processSchemaDescription, NO_ROLES } from "@scfloworg/core";
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

describe("browser.ts — area built-in dataset, fully in-memory", () => {
  it("overlays a built-in dataset created and populated purely via createDataset/putInstance — no disk involved", async () => {
    const impl = createJsPersistenceInterface("js-browser-builtin");
    registerPersistentFormat(impl);

    // Mirrors @scfloworg/app-framework's ensureApplicationModelBuiltin: the
    // built-in dataset is created and seeded in-memory, at the app's own
    // area, before the app dataset that overlays it is ever read — see
    // app_framework's application_model_builtin (HOW).
    const area = "app-area";
    await impl.createDataset(area, "Builtin");
    const schemas = new Map<string, NormalizedSchema>();
    const ctx = { resolveSchema: (n: string) => schemas.get(n), resolveScalarType: () => undefined };
    const widget = processSchemaDescription(
      { name: "widget", is_root: true, properties: [{ name: "label", type: "string" }] },
      ctx,
    );
    schemas.set("widget", widget);
    await impl.putInstance(area, "schema", "widget", widget as unknown as TransientValue, NO_ROLES);

    await initDataset(`js-browser-builtin:${area}/app`, "App");
    const created = await runCommand(`js-browser-builtin:${area}/app`, {
      create: "widget",
      input: [{ label: "First widget" }],
    });
    expect(created.after).toHaveLength(1);
    expect((created.after[0] as TransientObject).label).toBe("First widget");
  });

  it("resolves an unpopulated area's built-in rest as simply absent, without ever touching disk", async () => {
    const impl = createJsPersistenceInterface("js-browser-empty-area");
    expect(await impl.datasetExists("some/area")).toBe(false);
    await expect(impl.getDataset("some/area")).rejects.toMatchObject({ code: "dataset_not_found" });
  });
});
