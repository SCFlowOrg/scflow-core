import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TransientValue } from "@scfloworg/core";
import { createFileFormat } from "../src/index.js";

const samples = resolve(__dirname, "../../conformance/samples/project-file");
const taskId = "0c1f4a52-7e3b-4d7a-9a55-2f6d1c8e4b10";

const temporary: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "format-file-"));
  temporary.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function folderCopy(): string {
  const dir = join(tempDir(), "project");
  cpSync(join(samples, "folder"), dir, { recursive: true });
  return dir;
}

async function codeOf(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
}

describe("an unchanged project", () => {
  it("saves a folder to identical bytes and writes nothing", async () => {
    const dir = folderCopy();
    const format = createFileFormat();
    expect(await format.datasetExists(dir)).toBe(true);
    expect(await format.save(dir)).toEqual({ written: [], removed: [] });
  });

  it("saves a single file to identical bytes", async () => {
    const path = join(tempDir(), "p.json");
    cpSync(join(samples, "single-file.json"), path);
    const format = createFileFormat();
    await format.datasetExists(path);
    expect(await format.save(path)).toEqual({ written: [], removed: [] });
  });
});

describe("reading", () => {
  it("gives the instances, the dataset and the manifests", async () => {
    const dir = folderCopy();
    const format = createFileFormat();
    expect(await format.getInstance(dir, "tasks.task", taskId, {})).toEqual({
      id: taskId,
      title: "Write the sample",
    });
    const info = (await format.getDataset(dir)) as Record<string, unknown>;
    expect(info.name).toBe("demo");
    expect(info.data_minor_version).toBe(2);
    expect(info.modules).toEqual([
      { module: "acme:tasks", version: "1.0.0", digest: expect.stringMatching(/^sha256:/) },
    ]);
    expect(await format.getInstance(dir, "module", "acme:tasks", {})).toMatchObject({ namespace: "tasks" });
  });

  it("says no dataset is at a path that does not exist", async () => {
    expect(await createFileFormat().datasetExists(join(tempDir(), "none"))).toBe(false);
  });

  it("refuses to create a dataset over a project", async () => {
    const dir = folderCopy();
    expect(await codeOf(() => createFileFormat().createDataset(dir, "x"))).toBe("dataset_already_exists");
  });
});

describe("saving a change", () => {
  it("changes only data.json and keeps every other section", async () => {
    const dir = folderCopy();
    const format = createFileFormat();
    await format.putInstance(dir, "tasks.task", "z-task", { id: "z-task", title: "Second" }, {});
    expect((await format.save(dir)).written).toEqual(["data.json"]);
    expect(existsSync(join(dir, "unknown-folder/notes.txt"))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "ui.json"), "utf8")).version).toBe(1);

    const again = createFileFormat();
    expect(await again.getInstance(dir, "tasks.task", "z-task", {})).toEqual({ id: "z-task", title: "Second" });
    expect(await again.save(dir)).toEqual({ written: [], removed: [] });
  });

  it("sorts schemas, instances and the keys of an instance", async () => {
    const path = join(tempDir(), "new");
    const format = createFileFormat();
    await format.createDataset(path, "demo");
    await format.putInstance(path, "b.x", "2", { title: "t", id: "2" } as TransientValue, {});
    await format.putInstance(path, "b.x", "1", { z: { b: 1, a: 2 }, id: "1" } as TransientValue, {});
    await format.putInstance(path, "a.y", "k", { name: "k" } as TransientValue, {});
    await format.save(path);
    const data = readFileSync(join(path, "data.json"), "utf8");
    const instances = (JSON.parse(data) as { instances: Record<string, { id?: string }[]> }).instances;
    expect(Object.keys(instances)).toEqual(["a.y", "b.x"]);
    expect(instances["b.x"]?.map((i) => i.id)).toEqual(["1", "2"]);
    expect(Object.keys(instances["b.x"]?.[1] ?? {})).toEqual(["id", "title"]);
    expect(data.indexOf('"a": 2')).toBeLessThan(data.indexOf('"b": 1'));
    expect(data).not.toContain("\r");
  });

  it("gives the same bytes whatever the order of the writes", async () => {
    const write = async (keys: string[]) => {
      const path = join(tempDir(), "new");
      const format = createFileFormat();
      await format.createDataset(path, "demo");
      await format.updateDataset(path, { created_at: "t", updated_at: "t" });
      for (const key of keys) await format.putInstance(path, "a.x", key, { id: key }, {});
      await format.save(path);
      return readFileSync(join(path, "data.json"), "utf8");
    };
    expect(await write(["1", "2", "3"])).toBe(await write(["3", "1", "2"]));
  });

  it("keeps an instance stored under another key", async () => {
    const path = join(tempDir(), "new");
    const format = createFileFormat();
    await format.createDataset(path, "demo");
    await format.putInstance(path, "__internal_record__", "self", { schemas: {} }, {});
    await format.save(path);
    const again = createFileFormat();
    expect(await again.getInstance(path, "__internal_record__", "self", {})).toEqual({ schemas: {} });
    expect(await again.save(path)).toEqual({ written: [], removed: [] });
  });

  it("forgets a deleted instance", async () => {
    const dir = folderCopy();
    const format = createFileFormat();
    await format.datasetExists(dir);
    await format.deleteInstance(dir, "tasks.task", taskId);
    await format.save(dir);
    expect(readFileSync(join(dir, "data.json"), "utf8")).not.toContain(taskId);
  });

  it("saves a new project as a folder, or as a single file for a .json path", async () => {
    const root = tempDir();
    const format = createFileFormat();
    const folder = join(root, "a");
    const single = join(root, "b.json");
    await format.createDataset(folder, "a");
    await format.createDataset(single, "b");
    await format.save(folder);
    await format.save(single);
    expect(existsSync(join(folder, "project.json"))).toBe(true);
    expect(JSON.parse(readFileSync(single, "utf8")).data.name).toBe("b");
  });
});

describe("the project of a dataset", () => {
  it("lets a host change another section and saves it", async () => {
    const dir = folderCopy();
    const format = createFileFormat();
    await format.datasetExists(dir);
    format.project(dir).sections.set("ui", { version: 1, views: [] });
    expect((await format.save(dir)).written).toEqual(["ui.json"]);
  });

  it("keeps the memory of the disk after a save", async () => {
    const dir = folderCopy();
    const format = createFileFormat();
    await format.putInstance(dir, "tasks.task", "z", { id: "z" }, {});
    await format.save(dir);
    expect(await format.save(dir)).toEqual({ written: [], removed: [] });
  });
});

describe("a change made on disk meanwhile", () => {
  it("refuses to save over a changed section", async () => {
    const dir = folderCopy();
    const format = createFileFormat();
    await format.datasetExists(dir);
    writeFileSync(join(dir, "ui.json"), '{"version":1,"views":["other"]}');
    expect(await codeOf(() => format.save(dir))).toBe("project_changed_on_disk");
  });

  it("does not refuse a change of formatting only", async () => {
    const dir = folderCopy();
    const format = createFileFormat();
    await format.datasetExists(dir);
    const ui = JSON.parse(readFileSync(join(dir, "ui.json"), "utf8")) as unknown;
    writeFileSync(join(dir, "ui.json"), JSON.stringify(ui));
    expect(await format.save(dir)).toEqual({ written: [], removed: [] });
  });

  it("keeps an unknown file changed or added meanwhile", async () => {
    const dir = folderCopy();
    const format = createFileFormat();
    await format.putInstance(dir, "tasks.task", "z", { id: "z" }, {});
    writeFileSync(join(dir, "unknown-folder/notes.txt"), "changed by a tool");
    writeFileSync(join(dir, "unknown-folder/new.txt"), "added by a tool");
    await format.save(dir);
    expect(readFileSync(join(dir, "unknown-folder/notes.txt"), "utf8")).toBe("changed by a tool");
    expect(readFileSync(join(dir, "unknown-folder/new.txt"), "utf8")).toBe("added by a tool");
  });
});
