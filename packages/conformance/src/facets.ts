import { describe, expect, it } from "vitest";
import { createImport, dumpDataset, initDataset, readModuleManifest, runCommand } from "@scfloworg/core";
import type { ModuleManifest } from "@scfloworg/core";

type Row = Record<string, unknown>;

/** The module whose schemas carry the facets: `person`, a descendant `contractor`, and a facet of its own module. */
const tasksModule = (extra = "", schemas = "") => `
name: acme:tasks
namespace: tasks
version: 1.0.0
mcl: ^1.0
title: Tasks
schemas:
  - name: person
    shared_by_name:
    is_root:
    properties:
      - name: name
        type: identifier
      - name: code
        type: string
${extra}
  - name: contractor
    extends: person
    properties:
      - name: company
        type: string
  - name: badge_holder
    facet_of: person
    properties:
      - name: badge
        type: string
${schemas}
`;

/** A module that adds a facet, an owned schema and a virtual relation to `tasks.person`. */
const carbonModule = (facetExtra = "", schemas = "") => `
name: acme:carbon
namespace: carbon
version: 1.0.0
mcl: ^1.0
title: Carbon
dependencies:
  - module: acme:tasks
    version: ^1.0
schemas:
  - name: actor_emissions
    facet_of: tasks.person
    properties:
      - name: co2
        type: number
        minimum: 0
      - name: rating
        type: string
        default_value: unrated
      - name: auditor
        type: tasks.person
${facetExtra}
  - name: emission
    properties:
      - name: person
        type: tasks.person
        owner:
        inverse_name: emissions
        inverse_is_array:
      - name: amount
        type: number
${schemas}
`;

/**
 * Facets: piece 3.2 of `packages/core/docs/spec/meta-model.md`, section Facet,
 * and of `model-command-language.md`, *Facets* in Command, the path and
 * `exists` rules of Filter, and *Facets* and *Virtual relations across
 * modules* in Schema Processing.
 */
export function facetCases(formatPrefix: string, newLocator: () => string): void {
  const tasks = readModuleManifest(tasksModule());
  const carbon = readModuleManifest(carbonModule());
  const query = async (locator: string, command: Row = {}) =>
    (await runCommand(locator, { kind: "query", schema: "tasks.person", ...command })).after as Row[];
  const names = (rows: readonly unknown[]) => rows.map((r) => (r as Row).name).sort();
  const stored = async (locator: string, schema: string) =>
    ((JSON.parse(await dumpDataset(locator, "json")) as Row).data as Row)[schema] as Row | undefined;

  async function datasetWith(modules: ModuleManifest[]): Promise<string> {
    const locator = newLocator();
    await initDataset(locator, "facets", { modules });
    return locator;
  }

  const refused = async (modules: string[], code = "constraint_violation") => {
    await expect(initDataset(newLocator(), "refused", { modules: modules.map((m) => readModuleManifest(m)) })).rejects.toMatchObject({ code });
  };

  describe(`facet conformance — ${formatPrefix}`, () => {
    it("shows the properties of a facet on its target and its descendants, under the namespace of the facet's module", async () => {
      const locator = await datasetWith([tasks, carbon]);
      const created = await runCommand(locator, { create: "tasks.person", input: { name: "ada", code: "A", carbon: { co2: 12 } } });
      // an unset value is left out, a default_value is read when nothing is stored
      expect(created.after[0]).toEqual({ name: "ada", code: "A", carbon: { co2: 12, rating: "unrated", emissions: [] } });
      expect(await query(locator)).toEqual([{ name: "ada", code: "A", carbon: { co2: 12, rating: "unrated", emissions: [] } }]);

      // a facet of the target's own module carries that module's namespace
      await runCommand(locator, { create: "tasks.contractor", input: { name: "bob", company: "acme", tasks: { badge: "B-1" }, carbon: { co2: 3 } } });
      const [bob] = await query(locator, { filters: { name: "bob" } });
      expect(bob).toMatchObject({ name: "bob", company: "acme", tasks: { badge: "B-1" }, carbon: { co2: 3 } });

      // a dataset without the module sees the target bare
      const bare = await datasetWith([tasks]);
      const plain = await runCommand(bare, { create: "tasks.person", input: { name: "ada", code: "A" } });
      expect(plain.after[0]).toEqual({ name: "ada", code: "A" });
      expect((await runCommand(bare, { query: "tasks.person", filters: { "carbon.co2": 1 } }).catch((e: { code: string }) => e.code))).toBe("unknown_property");
    });

    it("names the properties of a facet by path, and an unset value satisfies only exists", async () => {
      const locator = await datasetWith([tasks, carbon]);
      await runCommand(locator, { create: "tasks.person", input: [{ name: "ada", carbon: { co2: 12 } }, { name: "bob", carbon: { co2: 3 } }, { name: "cyd" }] });

      expect(names(await query(locator, { filters: { "carbon.co2": { gt: 10 } } }))).toEqual(["ada"]);
      // ne on an unset value is not satisfied
      expect(names(await query(locator, { filters: { "carbon.co2": { ne: 12 } } }))).toEqual(["bob"]);
      expect(names(await query(locator, { filters: { "carbon.co2": { exists: false } } }))).toEqual(["cyd"]);
      expect(names(await query(locator, { filters: { "carbon.co2": { exists: true } } }))).toEqual(["ada", "bob"]);
      expect(names(await query(locator, { filters: { not: { "carbon.co2": { exists: true } } } }))).toEqual(["cyd"]);
      // a default_value is a value
      expect(names(await query(locator, { filters: { "carbon.rating": "unrated" } }))).toEqual(["ada", "bob", "cyd"]);
      await expect(runCommand(locator, { query: "tasks.person", filters: { "carbon.nothing": 1 } })).rejects.toMatchObject({ code: "unknown_property" });

      // result.properties names a facet property by path, or a whole namespace
      const narrowed = await query(locator, { filters: { name: "ada" }, result: { properties: ["carbon.co2"] } });
      expect(narrowed).toEqual([{ name: "ada", carbon: { co2: 12 } }]);
      const namespace = await query(locator, { filters: { name: "ada" }, result: { properties: ["carbon"] } });
      expect(namespace).toEqual([{ name: "ada", carbon: { co2: 12, rating: "unrated", emissions: [] } }]);

      // a path crossing a relation reaches the facet values of its target
      await runCommand(locator, { update: "tasks.person", filters: { name: "cyd" }, input: { carbon: { auditor: "ada" } } });
      expect(names(await query(locator, { filters: { "carbon.auditor.carbon.co2": 12 } }))).toEqual(["cyd"]);
    });

    it("creates the facet instance on its first value, patches it, and unsets a value with null", async () => {
      const locator = await datasetWith([tasks, carbon]);
      await runCommand(locator, { create: "tasks.person", input: [{ name: "ada" }, { name: "bob" }] });
      // using a module writes nothing
      expect(Object.keys((await stored(locator, "carbon.actor_emissions")) ?? {})).toEqual([]);

      await runCommand(locator, { update: "tasks.person", filters: { name: "ada" }, input: { carbon: { co2: 5 } } });
      expect(Object.keys((await stored(locator, "carbon.actor_emissions")) ?? {})).toEqual(["ada"]);
      // the instance of the target never holds them
      expect(((await stored(locator, "tasks.person")) as Row).ada).not.toHaveProperty("carbon");
      expect(((await stored(locator, "tasks.person")) as Row).ada).not.toHaveProperty("carbon.co2");

      // a patch changes only the properties it names
      const patched = await runCommand(locator, { update: "tasks.person", filters: { name: "ada" }, input: { carbon: { auditor: "bob" } } });
      expect(patched.before[0]).toMatchObject({ carbon: { co2: 5 } });
      expect(patched.after[0]).toMatchObject({ carbon: { co2: 5, auditor: "bob" } });

      const unset = await runCommand(locator, { update: "tasks.person", filters: { name: "ada" }, input: { carbon: { co2: null } } });
      expect(unset.after[0]).toEqual({ name: "ada", code: "", carbon: { rating: "unrated", auditor: "bob", emissions: [] } });

      // values are checked against the facet's properties
      await expect(runCommand(locator, { update: "tasks.person", filters: { name: "ada" }, input: { carbon: { co2: -1 } } })).rejects.toMatchObject({
        code: "constraint_violation",
      });
      await expect(runCommand(locator, { update: "tasks.person", filters: { name: "ada" }, input: { carbon: { nothing: 1 } } })).rejects.toMatchObject({
        code: "unknown_property",
      });
      await expect(runCommand(locator, { update: "tasks.person", filters: { name: "ada" }, input: { carbon: 3 } })).rejects.toMatchObject({
        code: "constraint_violation",
      });
      await expect(runCommand(locator, { create: "tasks.person", input: { name: "cyd", carbon: { auditor: "zed" } } })).rejects.toMatchObject({
        code: "unknown_relation_target",
      });
    });

    it("refuses a command on a facet with facet_not_addressable", async () => {
      const locator = await datasetWith([tasks, carbon]);
      await expect(runCommand(locator, { query: "carbon.actor_emissions" })).rejects.toMatchObject({ code: "facet_not_addressable" });
      await expect(runCommand(locator, { create: "carbon.actor_emissions", input: { co2: 1 } })).rejects.toMatchObject({ code: "facet_not_addressable" });
      await expect(runCommand(locator, { update: "tasks.badge_holder", input: { badge: "x" } })).rejects.toMatchObject({ code: "facet_not_addressable" });
    });

    it("removes the facet instances with their target, and unsets a facet relation to a deleted instance", async () => {
      const locator = await datasetWith([tasks, carbon]);
      await runCommand(locator, { create: "tasks.person", input: [{ name: "ada", tasks: { badge: "A" }, carbon: { co2: 1 } }, { name: "bob", carbon: { co2: 2, auditor: "ada" } }] });

      const deleted = await runCommand(locator, { delete: "tasks.person", filters: { name: "ada" } });
      expect(deleted.before[0]).toMatchObject({ name: "ada", carbon: { co2: 1 } });
      expect(deleted["updated-before"]).toEqual([expect.objectContaining({ name: "bob", carbon: expect.objectContaining({ auditor: "ada" }) })]);
      expect(deleted["updated-after"]).toEqual([{ name: "bob", code: "", carbon: { co2: 2, rating: "unrated", emissions: [] } }]);
      expect(Object.keys((await stored(locator, "carbon.actor_emissions")) ?? {})).toEqual(["bob"]);
      expect(Object.keys((await stored(locator, "tasks.badge_holder")) ?? {})).toEqual([]);
      expect((await query(locator))[0]).toEqual({ name: "bob", code: "", carbon: { co2: 2, rating: "unrated", emissions: [] } });

      // an instance whose last value is unset is removed
      await runCommand(locator, { update: "tasks.person", filters: { name: "bob" }, input: { carbon: { co2: null } } });
      expect(Object.keys((await stored(locator, "carbon.actor_emissions")) ?? {})).toEqual([]);
    });

    it("qualifies a virtual relation across modules by the namespace of the declaring module", async () => {
      const locator = await datasetWith([tasks, carbon]);
      await runCommand(locator, { create: "tasks.person", input: [{ name: "ada" }, { name: "bob" }] });
      const emission = (await runCommand(locator, { create: "carbon.emission", input: { person: "ada", amount: 3 } })).after[0] as Row;
      expect((await query(locator, { filters: { name: "ada" } }))[0]).toMatchObject({ carbon: { emissions: [emission.id] } });
      expect(names(await query(locator, { filters: { "carbon.emissions": { exists: true } } }))).toEqual(["ada"]);

      // the owned instance goes with its owner
      const deleted = await runCommand(locator, { delete: "tasks.person", filters: { name: "ada" } });
      expect(deleted["cascade-deleted"]).toEqual([expect.objectContaining({ id: emission.id })]);
      expect((await runCommand(locator, { query: "carbon.emission" })).after).toEqual([]);
    });

    it("shows the facet values of an imported instance, read-only", async () => {
      const source = await datasetWith([tasks, carbon]);
      await runCommand(source, { create: "tasks.person", input: { name: "ada", carbon: { co2: 7 } } });
      const target = await datasetWith([tasks, carbon]);
      await createImport(target, source);

      const [ada] = await query(target, { namespace: "*" });
      expect(ada).toMatchObject({ name: "facets.ada", carbon: { co2: 7 } });
      expect(names(await query(target, { namespace: "facets.", filters: { "carbon.co2": 7 } }))).toEqual(["facets.ada"]);
      await expect(runCommand(target, { update: "tasks.person", namespace: "facets.", input: { carbon: { co2: 1 } } })).rejects.toMatchObject({
        code: "constraint_violation",
      });
      const missed = await runCommand(target, { update: "tasks.person", filters: { name: "facets.ada" }, input: { carbon: { co2: 1 } } });
      expect(missed.after).toEqual([]);
      expect((await query(target, { namespace: "*" }))[0]).toMatchObject({ carbon: { co2: 7 } });
    });

    it("processes a facet as Schema Processing says", async () => {
      const t = tasksModule();
      await refused([t, carbonModule("      - name: name\n        type: string")]);
      await refused([t, carbonModule("      - name: owner\n        type: tasks.person\n        mandatory:")]);
      await refused([t, carbonModule("      - name: mentor\n        type: tasks.person\n        inverse_name: mentees")]);
      await refused([t, carbonModule("", "  - name: shared_facet\n    facet_of: tasks.person\n    shared_by_name:\n    properties:\n      - name: x\n        type: string")]);
      await refused([t, carbonModule("", "  - name: sub_facet\n    extends: actor_emissions\n    properties: []")]);
      await refused([t, carbonModule("", "  - name: deep_facet\n    facet_of: actor_emissions\n    properties:\n      - name: x\n        type: string")]);
      await refused([t, carbonModule("", "  - name: link\n    is_root:\n    properties:\n      - name: to\n        type: actor_emissions")]);
      await refused([t, carbonModule("", "  - name: unknown_target\n    facet_of: tasks.nobody\n    properties: []")], "unknown_extends_target");
      // a name clash between two facets of one module on one target
      await refused([t, carbonModule("", "  - name: actor_water\n    facet_of: tasks.person\n    properties:\n      - name: co2\n        type: number")]);
      // a property of the target named like a namespace in use
      await refused([tasksModule("      - name: carbon\n        type: string"), carbonModule()]);
      // inverse_is_mandatory across modules
      await refused([t, carbonModule("", "  - name: duty\n    is_root:\n    properties:\n      - name: of\n        type: tasks.person\n        inverse_name: duties\n        inverse_is_mandatory:")]);
      // a facet of an embedded schema
      await refused([tasksModule("", "  - name: address\n    embedded:\n    properties:\n      - name: city\n        type: string\n  - name: geo\n    facet_of: address\n    properties:\n      - name: lat\n        type: number")]);

      // two facets of one module on one target share the namespace
      const water = readModuleManifest(carbonModule("", "  - name: actor_water\n    facet_of: tasks.person\n    properties:\n      - name: liters\n        type: number"));
      const locator = await datasetWith([tasks, water]);
      const created = await runCommand(locator, { create: "tasks.person", input: { name: "ada", carbon: { co2: 1, liters: 2 } } });
      expect(created.after[0]).toMatchObject({ carbon: { co2: 1, liters: 2 } });
      expect(Object.keys((await stored(locator, "carbon.actor_water")) ?? {})).toEqual(["ada"]);
    });
  });
}
