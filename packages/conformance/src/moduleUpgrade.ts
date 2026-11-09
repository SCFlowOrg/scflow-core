import { describe, expect, it } from "vitest";
import { moduleDigest, readModuleManifest } from "@scfloworg/core";
import { createApiSession, initDataset, queryDataset, runCommand } from "@scfloworg/core/testing";
import type {
  MigrationStep,
  ModuleManifest,
  PersistenceInterface,
  TransientValue,
} from "@scfloworg/core";

type Row = Record<string, unknown>;

/** `acme:tasks` at `version`, with `task` given `taskProperties` and `migrations` listed. */
const tasksModule = (version: string, taskProperties: string, migrations = "", extra = "") =>
  readModuleManifest(`
name: acme:tasks
namespace: tasks
version: ${version}
mcl: ^1.0
title: Tasks
schemas:
  - name: task
    is_root:
    properties:
${taskProperties}
${extra}
${migrations ? `migrations:\n${migrations}` : ""}
`);

const TITLE = `      - name: title
        type: string`;
const LABEL = `      - name: label
        type: string`;
const PRIORITY = `      - name: priority
        type: integer
        default_value: 3`;

/**
 * Upgrading a module of a dataset: piece 4.3 of
 * `packages/core/docs/spec/meta-model.md`, Model Upgrade, and
 * `ApiSession.upgradeModule` of `typescript-reference-implementation.md`.
 */
export function moduleUpgradeCases(
  impl: PersistenceInterface,
  formatPrefix: string,
  newLocator: () => string,
): void {
  const v1 = tasksModule("1.0.0", TITLE);

  async function datasetWith(titles: string[], modules: ModuleManifest[] = [v1]): Promise<string> {
    const locator = newLocator();
    await initDataset(locator, "upgrade", { modules });
    for (const title of titles)
      await runCommand(locator, { create: "tasks.task", input: { title } });
    return locator;
  }
  const info = async (locator: string) => (await queryDataset(locator)) as Row;
  const tasks = async (locator: string) =>
    (await runCommand(locator, { query: "tasks.task" })).after as Row[];

  describe(`module upgrade conformance — ${formatPrefix}`, () => {
    it("applies a compatible change: the new manifest is embedded and the stored instances take their defaults", async () => {
      const locator = await datasetWith(["write"]);
      const before = await info(locator);
      const v11 = tasksModule("1.1.0", `${TITLE}\n${PRIORITY}`);
      const result = await createApiSession().upgradeModule(locator, v11);
      expect(result).toMatchObject({
        module: "acme:tasks",
        from: "1.0.0",
        to: "1.1.0",
        migrations: [],
        changed: true,
      });
      const after = await info(locator);
      expect(after.modules).toEqual([
        { module: "acme:tasks", version: "1.1.0", digest: await moduleDigest(v11) },
      ]);
      expect(after.data_minor_version).toBe((before.data_minor_version as number) + 1);
      expect(await tasks(locator)).toEqual([
        expect.objectContaining({ title: "write", priority: 3 }),
      ]);
    });

    it("bumps no data version when no instance is touched", async () => {
      const locator = await datasetWith([]);
      const before = await info(locator);
      const result = await createApiSession().upgradeModule(
        locator,
        tasksModule("1.1.0", `${TITLE}\n${PRIORITY}`),
      );
      expect(result.changed).toBe(false);
      expect((await info(locator)).data_minor_version).toBe(before.data_minor_version);
    });

    it("lets the installed module win over a hand-edited snapshot of the same version", async () => {
      const locator = await datasetWith(["write"]);
      const edited = tasksModule("1.0.0", `${TITLE}\n${PRIORITY}`);
      await createApiSession().upgradeModule(locator, edited);
      expect((await info(locator)).modules).toEqual([
        { module: "acme:tasks", version: "1.0.0", digest: await moduleDigest(edited) },
      ]);
      expect(await tasks(locator)).toEqual([expect.objectContaining({ priority: 3 })]);
    });

    it("refuses an incompatible change with no migration, and changes nothing", async () => {
      const locator = await datasetWith(["write"]);
      const before = await info(locator);
      const v2 = tasksModule("2.0.0", `      - name: title\n        type: integer`);
      await expect(createApiSession().upgradeModule(locator, v2)).rejects.toMatchObject({
        code: "incompatible_upgrade",
      });
      expect(await info(locator)).toMatchObject({
        modules: before.modules,
        data_minor_version: before.data_minor_version,
      });
      expect(await tasks(locator)).toEqual([expect.objectContaining({ title: "write" })]);
    });

    it("refuses an instance of a schema that leaves the module", async () => {
      const locator = await datasetWith(["write"]);
      const v2 = readModuleManifest(
        `name: acme:tasks\nnamespace: tasks\nversion: 2.0.0\nmcl: ^1.0\n`,
      );
      await expect(createApiSession().upgradeModule(locator, v2)).rejects.toMatchObject({
        code: "incompatible_upgrade",
      });
    });

    it("refuses a manifest that is not newer, a local module and a module the dataset does not use", async () => {
      const session = createApiSession();
      const locator = await datasetWith([]);
      await expect(session.upgradeModule(locator, v1)).rejects.toMatchObject({
        code: "constraint_violation",
      });
      const newer = await datasetWith([], [tasksModule("1.2.0", TITLE)]);
      await expect(session.upgradeModule(newer, v1)).rejects.toMatchObject({
        code: "constraint_violation",
      });
      const local = readModuleManifest(
        `name: local:notes\nnamespace: notes\nversion: 1.0.0\nmcl: ^1.0\n`,
      );
      await expect(session.upgradeModule(locator, local)).rejects.toMatchObject({
        code: "constraint_violation",
      });
      const other = readModuleManifest(
        `name: acme:other\nnamespace: other\nversion: 1.0.0\nmcl: ^1.0\n`,
      );
      await expect(session.upgradeModule(locator, other)).rejects.toMatchObject({
        code: "key_not_found",
      });
    });

    describe.skipIf(impl.supportsTransactions !== true)("migrations", () => {
      const migrations = ["0.9.0", "3.0.0", "2.0.0", "1.5.0"]
        .map((to) => `  - to: ${to}`)
        .join("\n");
      const v2 = tasksModule("2.0.0", LABEL, migrations);

      /** A host's migration code: moves `title` to `label`, through the session of the upgrade. */
      const renameTitle =
        (session: ReturnType<typeof createApiSession>, locator: string, seen: MigrationStep[]) =>
        async (step: MigrationStep): Promise<boolean> => {
          seen.push(step);
          if (step.to !== "2.0.0") return true;
          for (const task of (await session.runCommand(locator, { query: "tasks.task" }))
            .after as Row[]) {
            await session.runCommand(locator, {
              update: "tasks.task",
              filters: { id: task.id as string },
              input: [{ label: task.title as string }],
            });
          }
          return true;
        };

      it("runs the migrations between the embedded and the installed version, in version order", async () => {
        const locator = await datasetWith(["write", "read"]);
        const session = createApiSession();
        const seen: MigrationStep[] = [];
        const result = await session.upgradeModule(locator, v2, {
          migrate: renameTitle(session, locator, seen),
        });
        expect(seen.map((step) => step.to)).toEqual(["1.5.0", "2.0.0"]);
        expect(seen[0]).toMatchObject({
          module: "acme:tasks",
          from: "1.0.0",
          to: "1.5.0",
          migration: { to: "1.5.0" },
        });
        expect(result).toMatchObject({
          from: "1.0.0",
          to: "2.0.0",
          migrations: ["1.5.0", "2.0.0"],
          changed: true,
        });
        expect(result.delta).not.toBeNull();
        // the value the installed schema no longer declares is dropped at the end
        const upgraded = await tasks(locator);
        expect(upgraded.map((task) => task.label).sort()).toEqual(["read", "write"]);
        for (const task of upgraded) expect(task).not.toHaveProperty("title");
        expect(((await info(locator)).modules as Row[])[0]).toMatchObject({ version: "2.0.0" });
      });

      it("reads the stored values with the installed schemas during a migration", async () => {
        const locator = await datasetWith(["write"]);
        const session = createApiSession();
        let read: TransientValue[] = [];
        await session.upgradeModule(locator, v2, {
          migrate: async () => {
            read = (await session.runCommand(locator, { query: "tasks.task" })).after;
            return true;
          },
        });
        expect(read).toEqual([expect.objectContaining({ title: "write" })]);
      });

      it("rolls the whole upgrade back when a migration fails", async () => {
        const locator = await datasetWith(["write"]);
        const before = await info(locator);
        const session = createApiSession();
        const failing = async (step: MigrationStep) => {
          await renameTitle(session, locator, [])(step);
          if (step.to === "2.0.0") throw new Error("migration failed");
          return true;
        };
        await expect(session.upgradeModule(locator, v2, { migrate: failing })).rejects.toThrow(
          "migration failed",
        );
        expect(await info(locator)).toMatchObject({
          modules: before.modules,
          data_minor_version: before.data_minor_version,
        });
        const kept = await tasks(locator);
        expect(kept).toEqual([expect.objectContaining({ title: "write" })]);
        expect(kept[0]).not.toHaveProperty("label");
        // the session still runs commands with the embedded schemas
        await session.runCommand(locator, { create: "tasks.task", input: { title: "again" } });
      });

      it("refuses the upgrade when the instances do not match the installed schemas after the migrations", async () => {
        const locator = await datasetWith(["write"]);
        const v3 = tasksModule(
          "2.0.0",
          `      - name: title\n        type: integer`,
          "  - to: 2.0.0",
        );
        await expect(
          createApiSession().upgradeModule(locator, v3, { migrate: async () => true }),
        ).rejects.toMatchObject({
          code: "incompatible_upgrade",
        });
        expect(((await info(locator)).modules as Row[])[0]).toMatchObject({ version: "1.0.0" });
      });
    });
  });
}
