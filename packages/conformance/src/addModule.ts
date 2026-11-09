import { describe, expect, it } from "vitest";
import { moduleDigest, readModuleManifest } from "@scfloworg/core";
import { createApiSession, dumpDataset, initDataset, queryDataset, runCommand, setLocalModule } from "@scfloworg/core/testing";
import type { ModuleManifest } from "@scfloworg/core";

type Row = Record<string, unknown>;

const tasks = (version = "1.0.0", title = "Tasks") =>
  readModuleManifest(`
name: acme:tasks
namespace: tasks
version: ${version}
mcl: ^1.0
title: ${title}
schemas:
  - name: task
    is_root:
    properties:
      - name: title
        type: string
`);

const style = (namespace = "style", key = "acme:style") =>
  readModuleManifest(`
name: ${key}
namespace: ${namespace}
version: 1.0.0
mcl: ^1.0
title: Style
dependencies:
  - module: acme:tasks
    version: ^1.0
schemas:
  - name: task_style
    facet_of: tasks.task
    properties:
      - name: color
        type: string
        default_value: blue
`);

const add = (locator: string, manifests: ModuleManifest[]) => createApiSession().addModule(locator, manifests);

async function codeOf(run: Promise<unknown>): Promise<string | undefined> {
  try {
    await run;
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
}

/**
 * Adding a module to a dataset: Model Upgrade of
 * `packages/core/docs/spec/meta-model.md`, Adding a module, and
 * `ApiSession.addModule` of `typescript-reference-implementation.md`.
 */
export function addModuleCases(formatPrefix: string, newLocator: () => string): void {
  async function datasetWithTask(): Promise<string> {
    const locator = newLocator();
    await initDataset(locator, "add", { modules: [tasks()] });
    await runCommand(locator, { create: "tasks.task", input: { title: "write" } });
    return locator;
  }
  const info = async (locator: string) => (await queryDataset(locator)) as Row;
  const firstTask = async (locator: string) =>
    ((await runCommand(locator, { query: "tasks.task" })).after as Row[])[0];

  describe(`adding a module conformance — ${formatPrefix}`, () => {
    it("lists the module, embeds its manifest and bumps the model minor version only", async () => {
      const locator = await datasetWithTask();
      const before = await info(locator);
      expect(await add(locator, [style()])).toEqual(["acme:style"]);
      const after = await info(locator);
      expect(after.modules).toEqual([
        { module: "acme:tasks", version: "1.0.0", digest: await moduleDigest(tasks()) },
        { module: "acme:style", version: "1.0.0", digest: await moduleDigest(style()) },
      ]);
      expect(after.model_minor_version).toBe(((before.model_minor_version as number) ?? 0) + 1);
      expect(after.data_major_version).toBe(before.data_major_version);
      expect(after.data_minor_version).toBe(before.data_minor_version);
      expect(await dumpDataset(locator, "json")).toContain("task_style");
    });

    it("writes no facet instance: a facet reads its default_value", async () => {
      const locator = await datasetWithTask();
      await add(locator, [style()]);
      expect((await firstTask(locator)).style).toEqual({ color: "blue" });
      const dump = JSON.parse(await dumpDataset(locator, "json")) as { instances?: Record<string, unknown> };
      expect(Object.keys(dump.instances ?? {}).filter((schema) => schema.startsWith("style."))).toEqual([]);
    });

    it("adds a module and its dependency together, the dependency first", async () => {
      const locator = newLocator();
      await initDataset(locator, "add");
      expect(await add(locator, [tasks(), style()])).toEqual(["acme:tasks", "acme:style"]);
    });

    it("does nothing for a module already embedded with this version and digest", async () => {
      const locator = await datasetWithTask();
      const before = await info(locator);
      expect(await add(locator, [tasks()])).toEqual([]);
      expect(await info(locator)).toEqual(before);
    });

    it("adds only what is missing", async () => {
      const locator = await datasetWithTask();
      expect(await add(locator, [tasks(), style()])).toEqual(["acme:style"]);
    });

    it("refuses another version or digest of a module the dataset uses", async () => {
      const locator = await datasetWithTask();
      expect(await codeOf(add(locator, [tasks("1.1.0")]))).toBe("duplicate_name");
      expect(await codeOf(add(locator, [tasks("1.0.0", "Edited")]))).toBe("duplicate_name");
    });

    it("refuses a namespace conflict, and changes nothing", async () => {
      const locator = await datasetWithTask();
      const before = await info(locator);
      expect(await codeOf(add(locator, [style("tasks")]))).toBe("namespace_conflict");
      expect(await info(locator)).toEqual(before);
    });

    it("refuses a module whose dependency is missing, and changes nothing", async () => {
      const locator = newLocator();
      await initDataset(locator, "add");
      const before = await info(locator);
      expect(await codeOf(add(locator, [style()]))).toBeDefined();
      expect(await info(locator)).toEqual(before);
    });

    it("refuses a local module: setLocalModule adds those", async () => {
      const locator = await datasetWithTask();
      const local = readModuleManifest(`
name: local:notes
namespace: notes
version: 1.0.0
mcl: ^1.0
title: Notes
schemas: []
`);
      expect(await codeOf(add(locator, [local]))).toBe("constraint_violation");
      await setLocalModule(locator, local);
    });

    it("refuses during an open transaction", async () => {
      const locator = await datasetWithTask();
      const session = createApiSession();
      const tx = await session.beginTransaction(locator, "open");
      expect(await codeOf(session.addModule(locator, [style()]))).toBe("transaction_open");
      await session.rollbackTransaction(locator, tx);
    });

    it("fails with dataset_not_found for no dataset", async () => {
      expect(await codeOf(add(newLocator(), [style()]))).toBe("dataset_not_found");
    });
  });
}
