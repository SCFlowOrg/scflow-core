import { describe, expect, it } from "vitest";
import { processSchemaDescription, NO_ROLES } from "@scfloworg/core";
import { registerPersistentFormat, initDataset, runCommand, dumpDataset, restoreDataset } from "@scfloworg/core/testing";
import type { NormalizedSchema, TransientObject, TransientValue } from "@scfloworg/core";
import { createJsPersistenceInterface } from "../src/index.js";

/**
 * Checks, on the `js` format, that a schema instance stored under a bare key
 * with `putInstance` is usable by the command engine and survives a
 * dump/restore round trip, and that storing the same schema again leaves the
 * data untouched.
 *
 * The schema is copied by hand rather than through `builtinRestFor`; the
 * built-in import behavior is covered by the "built-in import conformance"
 * suite of `packages/conformance`.
 */
describe("model_only / built-in dataset — bare-key schema instance", () => {
  it("makes a hand-copied builtin schema usable for create, and survives a dump/restore round trip", async () => {
    const impl = createJsPersistenceInterface("js-builtin-poc");
    registerPersistentFormat(impl);

    // --- 1. The source dataset holding the schema to copy. ---
    await initDataset("js-builtin-poc:builtin", "Builtin");
    const schemas = new Map<string, NormalizedSchema>();
    const ctx = { resolveSchema: (n: string) => schemas.get(n), resolveScalarType: () => undefined };
    const widget = processSchemaDescription(
      { name: "widget", is_root: true, properties: [{ name: "label", type: "string" }] },
      ctx,
    );
    schemas.set("widget", widget);
    await impl.putInstance("builtin", "schema", "widget", widget as unknown as TransientValue, NO_ROLES);

    // --- 2. A consuming dataset receiving the schema under its bare key. ---
    await initDataset("js-builtin-poc:demo", "Demo");
    await impl.putInstance("demo", "schema", "widget", widget as unknown as TransientValue, NO_ROLES);

    // --- 3. The copied schema is usable through the engine without a `create` against "demo". ---
    const created = await runCommand("js-builtin-poc:demo", {
      create: "widget",
      input: [{ label: "First widget" }],
    });
    expect(created.after).toHaveLength(1);
    const widgetKey = (created.after[0] as TransientObject).id as string;
    expect((created.after[0] as TransientObject).label).toBe("First widget");

    // --- 4. Dump the consuming dataset and restore it under a new locator ---
    const dump = await dumpDataset("js-builtin-poc:demo", "json");
    const restore = await restoreDataset("js-builtin-poc:restored", dump, "json");
    // The dataset has no import, so nothing is pending realignment.
    expect(restore.pendingRealignment).toEqual([]);

    // --- 5. Both the schema and the data instance survived the round trip ---
    const queried = await runCommand("js-builtin-poc:restored", {
      query: "widget",
      filters: { id: widgetKey },
    });
    expect(queried.after).toHaveLength(1);
    expect((queried.after[0] as TransientObject).label).toBe("First widget");

    // --- 6. Storing the unchanged schema again leaves the restored data untouched:
    //        the model part and the data part are independent. ---
    await impl.putInstance("restored", "schema", "widget", widget as unknown as TransientValue, NO_ROLES);
    const queriedAfterRealign = await runCommand("js-builtin-poc:restored", {
      query: "widget",
      filters: { id: widgetKey },
    });
    expect(queriedAfterRealign.after).toHaveLength(1);
    expect((queriedAfterRealign.after[0] as TransientObject).label).toBe("First widget");
  });
});
