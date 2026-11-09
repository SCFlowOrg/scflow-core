import { describe, expect, it } from "vitest";
import { dumpDataset, queryDataset, registerPersistentFormat, restoreDataset, runCommand } from "../src/testing.js";
import { runSchemaCommand } from "../src/modelUpgrade.js";
import { loadResolvers } from "../src/resolvers.js";
import type { PersistenceInterface, TransientObject } from "../src/types.js";
import { fakeFormat } from "./mapTestSupport.js";

/**
 * `restoreDataset` creates, from the defaults, the extension instance that a
 * restored instance lacks (datasets.md, *Lifecycle*): a dump written before a
 * schema became an extension of the schema of its instances, whether the
 * extension is in the dataset or in its built-in, restores with them. The
 * versions of the dump are kept.
 */

const TASK: TransientObject = {
  name: "task",
  shared_by_name: true,
  properties: [
    { name: "name", type: "identifier" },
    { name: "title", type: "string" },
  ],
};

const BILLING: TransientObject = {
  name: "task_billing",
  properties: [
    { name: "task", type: "task", extension: true },
    { name: "rate", type: "integer", default_value: 10 },
    { name: "currency", type: "string", enum: ["EUR", "USD"], default_value: "EUR" },
  ],
};

const createSchemas = async (impl: PersistenceInterface, rest: string, ...input: TransientObject[]) =>
  runSchemaCommand(impl, rest, { kind: "create", schema: "schema", input }, await loadResolvers(impl, rest));

const createTasks = (locator: string, ...input: TransientObject[]) => runCommand(locator, { kind: "create", schema: "task", input });

const versionsOf = async (locator: string): Promise<TransientObject> => {
  const { model_major_version, model_minor_version, data_major_version, data_minor_version } = (await queryDataset(locator)) as TransientObject;
  return { model_major_version, model_minor_version, data_major_version, data_minor_version };
};

describe("extension — restore", () => {
  it("creates the extension instances a restored dump lacks, from the defaults, and keeps the versions of the dump", async () => {
    const impl = fakeFormat();
    registerPersistentFormat(impl);
    await impl.createDataset("d1", "Test");
    await createSchemas(impl, "d1", TASK, BILLING);
    const source = `${impl.name}:d1`;
    await createTasks(source, { name: "t1", title: "A" }, { name: "t2" });

    // a dump written before the extension existed holds no instance of it
    const dump = JSON.parse(await dumpDataset(source, "json")) as { dataset: TransientObject; data: Record<string, unknown> };
    delete dump.data.task_billing;
    const target = `${impl.name}:d2`;
    await restoreDataset(target, JSON.stringify(dump), "json");

    expect(await impl.getInstance("d2", "task_billing", "t1", {})).toMatchObject({ task: "t1", rate: 10, currency: "EUR" });
    expect(await impl.getInstance("d2", "task_billing", "t2", {})).toMatchObject({ task: "t2", rate: 10, currency: "EUR" });
    const result = await runCommand(target, { kind: "query", schema: "task" });
    expect(result.after.map((i) => (i as TransientObject).rate)).toEqual([10, 10]);
    expect(await versionsOf(target)).toEqual({
      model_major_version: dump.dataset.model_major_version,
      model_minor_version: dump.dataset.model_minor_version,
      data_major_version: dump.dataset.data_major_version,
      data_minor_version: dump.dataset.data_minor_version,
    });
  });

  it("leaves the extension instances the dump holds as they are", async () => {
    const impl = fakeFormat();
    registerPersistentFormat(impl);
    await impl.createDataset("d1", "Test");
    await createSchemas(impl, "d1", TASK, BILLING);
    const source = `${impl.name}:d1`;
    await createTasks(source, { name: "t1", rate: 25 });
    const target = `${impl.name}:d2`;
    await restoreDataset(target, await dumpDataset(source, "json"), "json");

    expect(await impl.getInstance("d2", "task_billing", "t1", {})).toMatchObject({ rate: 25 });
  });

});
