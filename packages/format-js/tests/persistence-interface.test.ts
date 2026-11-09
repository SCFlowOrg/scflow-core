import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createJsPersistenceInterface } from "../src/index.js";

describe("js PersistenceInterface primitives", () => {
  it("reports datasetExists correctly and rejects a duplicate createDataset", async () => {
    const impl = createJsPersistenceInterface();
    expect(await impl.datasetExists("d1")).toBe(false);
    await impl.createDataset("d1", "My Dataset");
    expect(await impl.datasetExists("d1")).toBe(true);
    await expect(impl.createDataset("d1", "Again")).rejects.toMatchObject({ code: "dataset_already_exists" });
  });

  it("throws dataset_not_found for any other call on a missing dataset", async () => {
    const impl = createJsPersistenceInterface();
    await expect(impl.getDataset("missing")).rejects.toMatchObject({ code: "dataset_not_found" });
    await expect(impl.listInstances("missing", "task")).rejects.toMatchObject({ code: "dataset_not_found" });
  });

  it("generates no id and stores an instance under the key it is given", async () => {
    const impl = createJsPersistenceInterface();
    await impl.createDataset("d1", "My Dataset");
    expect("nextId" in impl).toBe(false);
    const id = "6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f";
    await impl.putInstance("d1", "task", id, { id, title: "a" });
    expect(await impl.getInstance("d1", "task", id)).toEqual({ id, title: "a" });
    await impl.deleteInstance("d1", "task", id);
    expect(await impl.getInstance("d1", "task", id)).toBeNull();
  });

  it("returns null from getInstance for a missing key, and deep-clones stored instances", async () => {
    const impl = createJsPersistenceInterface();
    await impl.createDataset("d1", "My Dataset");
    expect(await impl.getInstance("d1", "task", "nope")).toBeNull();

    const instance = { id: "t1", title: "original", tags: ["a"] };
    await impl.putInstance("d1", "task", "t1", instance);
    instance.title = "mutated after put";
    const read = (await impl.getInstance("d1", "task", "t1")) as { title: string; tags: string[] };
    expect(read.title).toBe("original");
    read.tags.push("b");
    const readAgain = (await impl.getInstance("d1", "task", "t1")) as { tags: string[] };
    expect(readAgain.tags).toEqual(["a"]);
  });

  it("isolates datasets created with different createJsPersistenceInterface() instances", async () => {
    const implA = createJsPersistenceInterface();
    const implB = createJsPersistenceInterface();
    await implA.createDataset("shared-name", "A");
    expect(await implB.datasetExists("shared-name")).toBe(false);
  });

  it("deletes a dataset, and rejects deleting a missing or already-deleted one", async () => {
    const impl = createJsPersistenceInterface();
    await impl.createDataset("d1", "My Dataset");
    await impl.putInstance("d1", "task", "t1", { id: "t1", title: "a" });

    await impl.deleteDataset("d1");
    expect(await impl.datasetExists("d1")).toBe(false);
    await expect(impl.getDataset("d1")).rejects.toMatchObject({ code: "dataset_not_found" });
    await expect(impl.deleteDataset("d1")).rejects.toMatchObject({ code: "dataset_not_found" });

    await expect(impl.deleteDataset("never-created")).rejects.toMatchObject({ code: "dataset_not_found" });
  });

});
