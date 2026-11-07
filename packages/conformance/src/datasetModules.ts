import { describe, expect, it } from "vitest";
import {
  checkImport,
  createImport,
  dumpDataset,
  initDataset,
  moduleDigest,
  queryDataset,
  readModuleManifest,
  refreshImport,
  removeImport,
  restoreDataset,
  runCommand,
  setLocalModule,
} from "@scfloworg/core";
import type { ModuleManifest, TransientValue } from "@scfloworg/core";

type Row = Record<string, unknown>;

const tasksModule = (version = "1.0.0", key = "acme:tasks", extra = "") => `
name: ${key}
namespace: tasks
version: ${version}
mcl: ^1.0
title: Tasks
scalar_types:
  - name: code
    extends: string
    pattern: '^[A-Z]{3}$'
schemas:
  - name: person
    shared_by_name:
    is_root:
    properties:
      - name: name
        type: identifier
      - name: code
        type: code
${extra}
  - name: task
    is_root:
    properties:
      - name: title
        type: string
      - name: due
        type: date
      - name: assignee
        type: person
        inverse_name: tasks
        inverse_is_array:
`;

const notesModule = `
name: acme:notes
namespace: notes
version: 1.0.0
mcl: ^1.0
dependencies:
  - module: acme:tasks
    version: ^1.0
schemas:
  - name: note
    is_root:
    properties:
      - name: text
        type: string
      - name: about
        type: tasks.person
`;

/**
 * The modules of a dataset and `import` for data only: piece 4.2 of
 * `packages/core/docs/spec/meta-model.md`, sections Dataset and Import, and the
 * import API of `typescript-reference-implementation.md`.
 */
export function datasetModuleCases(formatPrefix: string, newLocator: () => string): void {
  const tasks = readModuleManifest(tasksModule());
  const keys = (rows: TransientValue[], prop = "name") => rows.map((r) => (r as Row)[prop]).sort();
  const people = async (locator: string, namespace?: string) =>
    (await runCommand(locator, { kind: "query", schema: "tasks.person", ...(namespace === undefined ? {} : { namespace }) })).after;

  async function datasetWith(name: string, modules: ModuleManifest[], names: string[] = []): Promise<string> {
    const locator = newLocator();
    await initDataset(locator, name, { modules });
    for (const person of names) await runCommand(locator, { create: "tasks.person", input: { name: person, code: "ABC" } });
    return locator;
  }

  describe(`dataset module conformance — ${formatPrefix}`, () => {
    it("lists the modules of a dataset, each with its version and digest", async () => {
      const locator = await datasetWith("uses_tasks", [tasks]);
      const dataset = (await queryDataset(locator)) as Row;
      expect(dataset.modules).toEqual([{ module: "acme:tasks", version: "1.0.0", digest: await moduleDigest(tasks) }]);
      expect(dataset.modules).toEqual([{ module: "acme:tasks", version: "1.0.0", digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) }]);
      // a dataset with no module lists none
      const empty = newLocator();
      await initDataset(empty, "no_modules");
      expect(((await queryDataset(empty)) as Row).modules).toEqual([]);
    });

    it("computes the digest on the canonical form of the manifest", async () => {
      const reordered = readModuleManifest(JSON.stringify(Object.fromEntries(Object.entries(tasks).reverse())));
      expect(await moduleDigest(reordered)).toBe(await moduleDigest(tasks));
      expect(await moduleDigest(readModuleManifest(tasksModule("1.0.1")))).not.toBe(await moduleDigest(tasks));
    });

    it("runs commands on the schemas of its modules, by qualified name", async () => {
      const locator = await datasetWith("commands", [tasks], ["ada"]);
      const created = await runCommand(locator, { create: "tasks.task", input: { title: "write", assignee: "ada", due: "2026-11-07" } });
      expect(created.after[0]).toMatchObject({ title: "write", assignee: "ada" });
      expect(await people(locator)).toEqual([expect.objectContaining({ name: "ada", tasks: [(created.after[0] as Row).id] })]);
      // a short name is never searched for across modules
      await expect(runCommand(locator, { query: "person" })).rejects.toMatchObject({ code: "unknown_schema" });
      // the scalar types of the module and of mcl:core are checked
      await expect(runCommand(locator, { create: "tasks.person", input: { name: "bob", code: "abc" } })).rejects.toMatchObject({ code: "constraint_violation" });
      await expect(runCommand(locator, { create: "tasks.task", input: { title: "x", due: "tomorrow" } })).rejects.toMatchObject({ code: "constraint_violation" });
      // the modules of a dataset are maintained by the engine
      await expect(runCommand(locator, { update: "dataset", input: { modules: [] } })).rejects.toMatchObject({ code: "constraint_violation" });
    });

    it("refuses two versions of one module, and two modules with one namespace", async () => {
      await expect(initDataset(newLocator(), "two_versions", { modules: [tasks, readModuleManifest(tasksModule("1.1.0"))] })).rejects.toMatchObject({
        code: "duplicate_name",
      });
      await expect(initDataset(newLocator(), "one_namespace", { modules: [tasks, readModuleManifest(tasksModule("1.0.0", "acme:other"))] })).rejects.toMatchObject({
        code: "namespace_conflict",
      });
    });

    it("embeds its modules in a dump, with their digest, and restores them", async () => {
      const locator = await datasetWith("dumped", [tasks], ["ada"]);
      const dump = JSON.parse(await dumpDataset(locator, "json")) as Row;
      expect(dump.modules).toEqual({ "acme:tasks": { version: "1.0.0", digest: await moduleDigest(tasks) } });
      expect(dump.model).toEqual({ "acme:tasks": tasks });
      expect(Object.keys(dump.data as Row)).toContain("tasks.person");

      const restored = newLocator();
      await restoreDataset(restored, JSON.stringify(dump), "json");
      expect(((await queryDataset(restored)) as Row).modules).toEqual(((await queryDataset(locator)) as Row).modules);
      expect(keys(await people(restored))).toEqual(["ada"]);
      await runCommand(restored, { create: "tasks.person", input: { name: "bob", code: "BOB" } });
    });

    it("refuses a hand-edited snapshot of a published module", async () => {
      const locator = await datasetWith("edited", [tasks]);
      const dump = JSON.parse(await dumpDataset(locator, "json")) as Row;
      ((dump.model as Row)["acme:tasks"] as Row).title = "Edited by hand";
      const restored = newLocator();
      await expect(restoreDataset(restored, JSON.stringify(dump), "json")).rejects.toMatchObject({ code: "invalid_dump" });
      expect(await queryDataset(restored)).toBeNull();
    });

    it("keeps a local module editable, in the dump and through setLocalModule", async () => {
      const local = readModuleManifest(tasksModule("1.0.0", "local:tasks"));
      const locator = await datasetWith("local", [local], ["ada"]);
      const dump = JSON.parse(await dumpDataset(locator, "json")) as Row;
      ((dump.model as Row)["local:tasks"] as Row).title = "Edited by hand";
      const restored = newLocator();
      await restoreDataset(restored, JSON.stringify(dump), "json");
      const edited = readModuleManifest(JSON.stringify((dump.model as Row)["local:tasks"]));
      expect(((await queryDataset(restored)) as Row).modules).toEqual([{ module: "local:tasks", version: "1.0.0", digest: await moduleDigest(edited) }]);

      // a property with a default is backfilled on the instances already there
      const grown = readModuleManifest(tasksModule("1.1.0", "local:tasks", "      - name: team\n        type: string\n        default_value: core"));
      const dataset = (await setLocalModule(locator, grown)) as Row;
      expect(dataset.modules).toEqual([{ module: "local:tasks", version: "1.1.0", digest: await moduleDigest(grown) }]);
      expect(await people(locator)).toEqual([expect.objectContaining({ name: "ada", team: "core" })]);

      // a change the instances cannot take is refused, and changes nothing
      const mandatory = readModuleManifest(tasksModule("1.2.0", "local:tasks", "      - name: mentor\n        type: person\n        mandatory:"));
      await expect(setLocalModule(locator, mandatory)).rejects.toMatchObject({ code: "incompatible_upgrade" });
      expect(((await queryDataset(locator)) as Row).modules).toEqual(dataset.modules);

      // a published module is changed by a model upgrade only
      await expect(setLocalModule(locator, tasks)).rejects.toMatchObject({ code: "constraint_violation" });
    });
  });

  describe(`import conformance — ${formatPrefix}`, () => {
    it("copies the instances of the imported dataset, under a namespace, with its modules", async () => {
      const source = await datasetWith("suppliers", [tasks], ["ada"]);
      const task = (await runCommand(source, { create: "tasks.task", input: { title: "audit", assignee: "ada", due: "2026-11-07" } })).after[0] as Row;
      const target = newLocator();
      await initDataset(target, "buyer");
      const before = (await queryDataset(target)) as Row;

      const created = (await createImport(target, source)) as Row;
      expect(created).toMatchObject({ name: "suppliers", locator: source, namespace: "suppliers.", data_major_version: 0, caching_policy: "full" });
      const dataset = (await queryDataset(target)) as Row;
      // an imported dataset brings its modules
      expect(dataset.modules).toEqual(((await queryDataset(source)) as Row).modules);
      expect(dataset.imports).toEqual(["suppliers"]);
      expect(dataset.data_minor_version).toBe((before.data_minor_version as number) + 1);

      // the keys of the copies are prefixed, and so are their relations
      expect(await people(target)).toEqual([]);
      expect(await people(target, "suppliers.")).toEqual([expect.objectContaining({ name: "suppliers.ada", tasks: [`suppliers.${task.id}`] })]);
      const copies = (await runCommand(target, { query: "tasks.task", namespace: "*" })).after;
      expect(copies).toEqual([expect.objectContaining({ id: `suppliers.${task.id}`, assignee: "suppliers.ada" })]);
      expect((await runCommand(target, { query: "import" })).after).toEqual([expect.objectContaining({ name: "suppliers", namespace: "suppliers." })]);
    });

    it("keeps imported instances read-only, and lets own instances relate to them", async () => {
      const source = await datasetWith("catalog", [tasks], ["ada"]);
      const target = await datasetWith("project", [tasks], ["bob"]);
      await createImport(target, source);

      await expect(runCommand(target, { update: "tasks.person", namespace: "catalog.", input: { code: "XYZ" } })).rejects.toMatchObject({
        code: "constraint_violation",
      });
      await runCommand(target, { update: "tasks.person", input: { code: "XYZ" } });
      await runCommand(target, { delete: "tasks.person" });
      expect(await people(target, "*")).toEqual([expect.objectContaining({ name: "catalog.ada", code: "ABC" })]);

      const own = await runCommand(target, { create: "tasks.task", input: { title: "call", assignee: "catalog.ada", due: "2026-11-07" } });
      expect(own.after[0]).toMatchObject({ assignee: "catalog.ada" });
      await expect(runCommand(target, { create: "import", input: { name: "x" } })).rejects.toMatchObject({ code: "import_cannot_be_created" });
    });

    it("checks an import before making it", async () => {
      const source = await datasetWith("parts", [tasks], ["ada"]);
      const target = await datasetWith("assembly", [tasks]);

      const same = await checkImport(target, target);
      expect(same).toEqual({ canImport: false, backImport: null, existingImport: null, additionalImports: [] });

      expect(await checkImport(target, source)).toEqual({ canImport: true, backImport: null, existingImport: null, additionalImports: [] });
      const created = await createImport(target, source);
      const again = await checkImport(target, source);
      expect(again.existingImport).toMatchObject({ name: "parts" });
      // already imported, at the same versions: nothing more is done
      expect(await createImport(target, source)).toEqual(created);
      expect(await people(target, "*")).toHaveLength(1);

      // no back loop
      const back = await checkImport(source, target);
      expect(back.canImport).toBe(false);
      expect(back.backImport).toMatchObject({ locator: source });
      await expect(createImport(source, target)).rejects.toMatchObject({ code: "cannot_import" });
    });

    it("refuses an import that brings a second version of a module", async () => {
      const source = await datasetWith("newer", [readModuleManifest(tasksModule("1.1.0"))], ["ada"]);
      const target = await datasetWith("older", [tasks]);
      expect((await checkImport(target, source)).canImport).toBe(false);
      await expect(createImport(target, source)).rejects.toMatchObject({ code: "cannot_import" });
      expect(((await queryDataset(target)) as Row).imports).toEqual([]);
    });

    it("flattens the imports of the imported dataset", async () => {
      const notes = readModuleManifest(notesModule);
      const base = await datasetWith("base", [tasks], ["ada"]);
      const middle = await datasetWith("middle", [tasks, notes]);
      await createImport(middle, base);
      await runCommand(middle, { create: "notes.note", input: { text: "reliable", about: "base.ada" } });

      const top = newLocator();
      await initDataset(top, "top");
      const check = await checkImport(top, middle);
      expect(check.additionalImports).toEqual([{ imported: expect.objectContaining({ locator: base }), existing: null }]);
      await createImport(top, middle);

      const dataset = (await queryDataset(top)) as Row;
      expect([...(dataset.imports as string[])].sort()).toEqual(["base", "middle"]);
      expect(keys(dataset.modules as TransientValue[], "module")).toEqual(["acme:notes", "acme:tasks"]);
      expect(await people(top, "base.")).toEqual([expect.objectContaining({ name: "base.ada" })]);
      const copied = (await runCommand(top, { query: "notes.note", namespace: "middle." })).after;
      expect(copied).toEqual([expect.objectContaining({ text: "reliable", about: "base.ada" })]);

      // importing the nested dataset again finds it already there
      expect((await checkImport(top, base)).existingImport).toMatchObject({ locator: base });
    });

    it("refreshes an import, and refuses it until the dataset has upgraded its modules", async () => {
      const local = (version: string) => readModuleManifest(tasksModule(version, "local:tasks"));
      const source = await datasetWith("shared", [local("1.0.0")], ["ada", "bob"]);
      const target = newLocator();
      await initDataset(target, "consumer");
      await createImport(target, source);
      const own = (await runCommand(target, { create: "tasks.task", input: { title: "meet", assignee: "shared.bob", due: "2026-11-07" } })).after[0] as Row;

      await runCommand(source, { create: "tasks.person", input: { name: "cyd", code: "CYD" } });
      await runCommand(source, { update: "tasks.person", filters: { name: "ada" }, input: { code: "ADA" } });
      await runCommand(source, { delete: "tasks.person", filters: { name: "bob" } });

      const refreshed = await refreshImport(target, "shared");
      expect(keys(refreshed.added)).toEqual(["shared.cyd"]);
      expect(keys(refreshed.removed)).toEqual(["shared.bob"]);
      expect(refreshed.before).toEqual([expect.objectContaining({ name: "shared.ada", code: "ABC" })]);
      expect(refreshed.after).toEqual([expect.objectContaining({ name: "shared.ada", code: "ADA" })]);
      expect(refreshed["updated-after"]).toEqual([expect.objectContaining({ id: own.id, assignee: null })]);
      expect(keys(await people(target, "shared."))).toEqual(["shared.ada", "shared.cyd"]);
      const sourceVersion = ((await queryDataset(source)) as Row).data_minor_version;
      expect((await runCommand(target, { query: "import" })).after[0]).toMatchObject({ data_minor_version: sourceVersion });

      await setLocalModule(source, local("1.1.0"));
      await expect(refreshImport(target, "shared")).rejects.toMatchObject({ code: "import_not_upgraded" });
      await setLocalModule(target, local("1.1.0"));
      await refreshImport(target, "shared");
    });

    it("removes an import with its instances", async () => {
      const source = await datasetWith("old_supplier", [tasks], ["ada"]);
      const target = newLocator();
      await initDataset(target, "buyer");
      await createImport(target, source);
      expect(await removeImport(target, "old_supplier")).toMatchObject({ name: "old_supplier", locator: source });
      expect(await people(target, "*")).toEqual([]);
      expect(((await queryDataset(target)) as Row).imports).toEqual([]);
      await expect(removeImport(target, "old_supplier")).rejects.toMatchObject({ code: "key_not_found" });
    });
  });
}
