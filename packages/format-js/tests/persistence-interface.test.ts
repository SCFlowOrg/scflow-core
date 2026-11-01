import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as YAML from "js-yaml";
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

  /**
   * `areaOf`/`builtinRestFor` (see the doc comments of `PersistenceInterface` for the area
   * and the built-in dataset): two PersistenceInterface methods, both synchronous, pure functions of
   * `rest` — nothing about the ten methods above changes. This format's own chosen convention:
   * `rest` is always `"<area>/<localRest>"`, where `area` is the filesystem path to a YAML file
   * holding that area's built-in `model_only` dataset (a `dumpDataset`-shaped dump — `dataset`/
   * `schemas`/`scalar_types`, see `readAreaYaml` in src/index.ts). `areaOf` returns the part
   * before the *last* "/" (so the path itself may contain "/"s), or "" if there's no "/" at all.
   * `builtinRestFor` is exactly `areaOf(rest)` — the bare path IS the rest the built-in dataset is
   * read from, no further in-memory `createDataset` needed at that rest.
   */
  describe("areaOf / builtinRestFor", () => {
    it("groups rests sharing the same leading segment into the same area", () => {
      const impl = createJsPersistenceInterface();
      expect(impl.areaOf("area-a/d1")).toBe("area-a");
      expect(impl.areaOf("area-a/d2")).toBe("area-a");
      expect(impl.areaOf("area-b/d1")).toBe("area-b");
    });

    it("keeps the full directory path when the area itself contains slashes", () => {
      const impl = createJsPersistenceInterface();
      expect(impl.areaOf("some/nested/dir/builtin.yaml/d1")).toBe("some/nested/dir/builtin.yaml");
    });

    it("treats a rest with no area segment as the empty-string area", () => {
      const impl = createJsPersistenceInterface();
      expect(impl.areaOf("d1")).toBe("");
    });

    it("returns the same builtinRestFor result for two rests in the same area, and a different one for a different area", () => {
      const impl = createJsPersistenceInterface();
      const builtinA1 = impl.builtinRestFor("area-a/d1");
      const builtinA2 = impl.builtinRestFor("area-a/d2");
      const builtinB = impl.builtinRestFor("area-b/d1");
      expect(builtinA1).toBeDefined();
      expect(builtinA1).toBe(builtinA2);
      expect(builtinB).toBeDefined();
      expect(builtinB).not.toBe(builtinA1);
    });

    it("is exactly the area path — no extra suffix", () => {
      const impl = createJsPersistenceInterface();
      expect(impl.builtinRestFor("area-a/d1")).toBe("area-a");
    });
  });

  /**
   * The built-in dataset itself is read straight off disk: `builtinRestFor(rest)` names a
   * filesystem path, and that path is expected to hold a `dumpDataset`-shaped YAML file (see
   * `readAreaYaml`/`resolveState` in src/index.ts). Nothing is cached — every call re-reads and
   * re-parses the file — so this is read-only from the format's own point of view: none of the
   * write primitives (createDataset/updateDataset/putInstance/deleteInstance/deleteDataset) ever
   * touch a YAML-backed rest, since they only ever look at the in-memory registry.
   */
  describe("area's built-in dataset — read from a YAML file on disk", () => {
    let dir: string;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "format-js-builtin-"));
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    async function writeAreaYaml(path: string, schemas: Record<string, unknown>) {
      const dump = {
        dataset: {
          name: "Builtin",
          model_major_version: 1,
          model_minor_version: 0,
          data_major_version: 0,
          data_minor_version: 0,
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
        },
        schemas,
        scalar_types: {},
        imports: {},
        data: {},
      };
      await writeFile(path, YAML.dump(dump), "utf-8");
    }

    it("resolves an area's built-in dataset by reading the YAML file its path points at", async () => {
      const impl = createJsPersistenceInterface();
      const areaYaml = join(dir, "builtin.yaml");
      await writeAreaYaml(areaYaml, { widget: { name: "widget", is_root: true, properties: [] } });

      const builtinRest = impl.builtinRestFor(`${areaYaml}/demo`) as string;
      expect(builtinRest).toBe(areaYaml);
      expect(await impl.datasetExists(builtinRest)).toBe(true);

      const info = (await impl.getDataset(builtinRest)) as { name: string };
      expect(info.name).toBe("Builtin");

      const schemas = await impl.listInstances(builtinRest, "schema");
      expect(schemas).toEqual([{ name: "widget", is_root: true, properties: [] }]);
      expect(await impl.listInstances(builtinRest, "scalar_type")).toEqual([]);
    });

    it("reports datasetExists false, and a missing dataset error, for a rest pointing at no file", async () => {
      const impl = createJsPersistenceInterface();
      const missing = join(dir, "nope.yaml");
      expect(await impl.datasetExists(missing)).toBe(false);
      await expect(impl.getDataset(missing)).rejects.toMatchObject({ code: "dataset_not_found" });
    });

    it("rejects createDataset at a rest a YAML file already occupies", async () => {
      const impl = createJsPersistenceInterface();
      const areaYaml = join(dir, "builtin.yaml");
      await writeAreaYaml(areaYaml, {});
      await expect(impl.createDataset(areaYaml, "Again")).rejects.toMatchObject({
        code: "dataset_already_exists",
      });
    });

    it("is read-only: updateDataset/putInstance/deleteDataset against a YAML-backed rest throw dataset_not_found", async () => {
      const impl = createJsPersistenceInterface();
      const areaYaml = join(dir, "builtin.yaml");
      await writeAreaYaml(areaYaml, { widget: { name: "widget", is_root: true, properties: [] } });

      await expect(impl.updateDataset(areaYaml, { name: "Renamed" })).rejects.toMatchObject({
        code: "dataset_not_found",
      });
      await expect(
        impl.putInstance(areaYaml, "schema", "gadget", { name: "gadget", is_root: true, properties: [] }),
      ).rejects.toMatchObject({ code: "dataset_not_found" });
      await expect(impl.deleteDataset(areaYaml)).rejects.toMatchObject({ code: "dataset_not_found" });
    });

    it("reads the file fresh on every call — an edit on disk is visible on the very next read, no caching", async () => {
      const impl = createJsPersistenceInterface();
      const areaYaml = join(dir, "builtin.yaml");
      await writeAreaYaml(areaYaml, { widget: { name: "widget", is_root: true, properties: [] } });
      expect(await impl.listInstances(areaYaml, "schema")).toHaveLength(1);

      await writeAreaYaml(areaYaml, {
        widget: { name: "widget", is_root: true, properties: [] },
        gadget: { name: "gadget", is_root: true, properties: [] },
      });
      expect(await impl.listInstances(areaYaml, "schema")).toHaveLength(2);
    });
  });
});
