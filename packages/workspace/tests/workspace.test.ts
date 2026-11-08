import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readModuleManifest } from "@scfloworg/core";
import { createEnvironment } from "@scfloworg/environment";
import { createFileFormat } from "@scfloworg/format-file";
import { createJsPersistenceInterface } from "@scfloworg/format-js";
import { defineModule } from "@scfloworg/module";
import { createWorkspace, type Document } from "../src/index.js";

const manifest = () =>
  readModuleManifest(`
name: acme:tasks
namespace: tasks
version: 1.0.0
mcl: ^1.0
title: Tasks
schemas:
  - name: task
    is_root:
    properties:
      - name: title
        type: string
`);

const temporary: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "workspace-"));
  temporary.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const file = createFileFormat();
  const environment = createEnvironment({ formats: [file] });
  environment.modules.install(defineModule(manifest()));
  return { environment, file, workspace: createWorkspace({ environment, file }) };
}

async function newDocument(path = join(tempDir(), "project")) {
  const context = setup();
  const doc = await context.workspace.create({ path, modules: ["acme:tasks"], type: "acme:tasks", title: "Demo" });
  return { ...context, doc, path };
}

async function titles(doc: Document): Promise<string[]> {
  const rows = (await doc.dataset.query({ query: "tasks.task" })).after as { title: string }[];
  return rows.map((row) => row.title).sort();
}

const add = (doc: Document, title: string) => doc.run("tasks/create_task", { title });

async function codeOf(run: () => unknown): Promise<string | undefined> {
  try {
    await run();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
}

function reopened(path: string) {
  return setup().workspace.open(path);
}

describe("documents", () => {
  it("writes nothing before save, then saves and reopens", async () => {
    const { doc, path } = await newDocument();
    await add(doc, "One");
    expect(existsSync(path)).toBe(false);
    await doc.save();
    const again = await reopened(path);
    expect(await titles(again)).toEqual(["One"]);
    expect(again.type).toBe("acme:tasks");
    expect(again.title).toBe("Demo");
  });

  it("gives identical bytes when a reopened document saves with no change", async () => {
    const { doc, path } = await newDocument();
    await add(doc, "One");
    await doc.save();
    const before = readdirSync(path).map((name) => [name, readFileSync(join(path, name), "utf8")]);
    const again = await reopened(path);
    expect(await again.save()).toEqual({ written: [], removed: [] });
    expect(readdirSync(path).map((name) => [name, readFileSync(join(path, name), "utf8")])).toEqual(before);
  });

  it("gives the same document for a path already open", async () => {
    const { doc, path, workspace } = await newDocument();
    expect(await workspace.open(path)).toBe(doc);
    expect(workspace.get(path)).toBe(doc);
    expect(workspace.list()).toEqual([doc]);
  });

  it("forgets what was not saved on close", async () => {
    const { doc, path, workspace } = await newDocument();
    await add(doc, "Saved");
    await doc.save();
    await add(doc, "Not saved");
    await doc.close();
    expect(workspace.get(path)).toBeUndefined();
    expect(await titles(await workspace.open(path))).toEqual(["Saved"]);
  });

  it("refuses a format that is not in the environment", () => {
    const environment = createEnvironment({ formats: [createJsPersistenceInterface()] });
    expect(() => createWorkspace({ environment, file: createFileFormat() })).toThrow(/unknown_format|not one of/);
  });
});

describe("sections", () => {
  it("keeps a section of another owner across saves", async () => {
    const { doc, path } = await newDocument();
    doc.setSection("ui", { version: 1, views: ["a"] });
    await add(doc, "One");
    await doc.save();
    const again = await reopened(path);
    expect(again.section("ui")).toEqual({ version: 1, views: ["a"] });
    await add(again, "Two");
    await again.save();
    expect(JSON.parse(readFileSync(join(path, "ui.json"), "utf8"))).toEqual({ version: 1, views: ["a"] });
  });

  it("refuses to write a section of the dataset", async () => {
    const { doc } = await newDocument();
    for (const key of ["modules", "model", "data"]) {
      expect(await codeOf(() => doc.setSection(key, {}))).toBe("reserved_section");
    }
  });

  it("saves a change of title", async () => {
    const { doc, path } = await newDocument();
    await doc.save();
    doc.title = "Renamed";
    expect((await doc.save()).written).toEqual(["project.json"]);
    expect((await reopened(path)).title).toBe("Renamed");
  });
});

describe("transactions", () => {
  it("groups actions in one undo step", async () => {
    const { doc } = await newDocument();
    await doc.transaction("Two tasks", async (tx) => {
      await tx.run("tasks/create_task", { title: "A" });
      await tx.run("tasks/create_task", { title: "B" });
    });
    expect(doc.history().undo).toEqual(["Two tasks"]);
    await doc.undo();
    expect(await titles(doc)).toEqual([]);
  });

  it("rolls back when the function throws", async () => {
    const { doc } = await newDocument();
    await expect(
      doc.transaction("Fails", async (tx) => {
        await tx.run("tasks/create_task", { title: "A" });
        throw new Error("no");
      }),
    ).rejects.toThrow("no");
    expect(await titles(doc)).toEqual([]);
    expect(doc.history().undo).toEqual([]);
  });

  it("rolls everything back when an action is refused inside", async () => {
    const { doc } = await newDocument();
    await doc.begin("Mixed");
    await doc.run("tasks/create_task", { title: "A" });
    expect(await codeOf(() => doc.run("tasks/create_task", { title: 12 }))).toBe("invalid_parameters");
    expect(await titles(doc)).toEqual([]);
    expect(await codeOf(() => doc.commit())).toBe("no_transaction");
  });

  it("exposes the phases", async () => {
    const { doc } = await newDocument();
    await doc.begin("Phases");
    await doc.run("tasks/create_task", { title: "A" });
    const prepared = await doc.prepare();
    expect(prepared.changed).toBe(true);
    await doc.commit();
    expect(doc.history().undo).toEqual(["Phases"]);
  });

  it("discards through rollback", async () => {
    const { doc } = await newDocument();
    await doc.begin("Phases");
    await doc.run("tasks/create_task", { title: "A" });
    await doc.rollback();
    expect(await titles(doc)).toEqual([]);
    expect(doc.history().undo).toEqual([]);
  });

  it("refuses what cannot happen during a transaction", async () => {
    const { doc } = await newDocument();
    await doc.begin("Open");
    for (const call of [() => doc.begin("Again"), () => doc.undo(), () => doc.redo(), () => doc.save()]) {
      expect(await codeOf(call)).toBe("transaction_open");
    }
    await doc.rollback();
  });

  it("refuses the phases with no transaction", async () => {
    const { doc } = await newDocument();
    for (const call of [() => doc.prepare(), () => doc.commit(), () => doc.rollback()]) {
      expect(await codeOf(call)).toBe("no_transaction");
    }
  });
});

describe("undo", () => {
  it("undoes and redoes several steps in a row", async () => {
    const { doc } = await newDocument();
    await add(doc, "A");
    await add(doc, "B");
    await add(doc, "C");
    expect(await doc.undo()).toBe(true);
    expect(await doc.undo()).toBe(true);
    expect(await titles(doc)).toEqual(["A"]);
    expect(await doc.redo()).toBe(true);
    expect(await titles(doc)).toEqual(["A", "B"]);
    expect(await doc.undo()).toBe(true);
    expect(await doc.undo()).toBe(true);
    expect(await titles(doc)).toEqual([]);
    expect(await doc.undo()).toBe(false);
  });

  it("names a step after the title of the action", async () => {
    const { doc } = await newDocument();
    await add(doc, "A");
    expect(doc.history().undo).toHaveLength(1);
    expect(doc.history().undo[0]).toMatch(/task/i);
  });

  it("clears redo on a new step", async () => {
    const { doc } = await newDocument();
    await add(doc, "A");
    await doc.undo();
    await add(doc, "B");
    expect(doc.history().redo).toEqual([]);
    expect(await doc.redo()).toBe(false);
  });

  it("adds no step for a transaction that changed nothing", async () => {
    const { doc } = await newDocument();
    await doc.transaction("Nothing", async () => undefined);
    expect(doc.history().undo).toEqual([]);
  });

  it("keeps 50 steps", async () => {
    const { doc } = await newDocument();
    for (let i = 0; i < 52; i++) await add(doc, `T${i}`);
    expect(doc.history().undo).toHaveLength(50);
  });

  it("keeps the history across a save, and saves the undone state", async () => {
    const { doc, path } = await newDocument();
    await add(doc, "A");
    await doc.save();
    await doc.undo();
    await doc.save();
    expect(await titles(await reopened(path))).toEqual([]);
  });
});

describe("read-only documents", () => {
  async function savedProject() {
    const { doc, path } = await newDocument();
    await add(doc, "One");
    await doc.save();
    return path;
  }

  it("opens read only on request and refuses writes", async () => {
    const path = await savedProject();
    const doc = await setup().workspace.open(path, { readOnly: true });
    expect(doc.readOnly).toBe(true);
    expect(await codeOf(() => add(doc, "No"))).toBe("read_only_dataset");
    for (const call of [
      () => doc.begin("x"),
      () => doc.undo(),
      () => doc.redo(),
      () => doc.save(),
      () => doc.setSection("ui", {}),
    ]) {
      expect(await codeOf(call)).toBe("read_only_document");
    }
    expect(await titles(doc)).toEqual(["One"]);
  });

  it("opens read only when a module is not installed", async () => {
    const path = await savedProject();
    const file = createFileFormat();
    const environment = createEnvironment({ formats: [file] });
    const doc = await createWorkspace({ environment, file }).open(path);
    expect(doc.readOnly).toBe(true);
  });

  it("opens read only when a manifest was edited by hand", async () => {
    const path = await savedProject();
    const model = JSON.parse(readFileSync(join(path, "model.json"), "utf8")) as Record<string, { title: string }>;
    (model["acme:tasks"] as { title: string }).title = "Edited";
    writeFileSync(join(path, "model.json"), JSON.stringify(model));
    const doc = await setup().workspace.open(path);
    expect(doc.handEdited).toEqual(["acme:tasks"]);
    expect(doc.readOnly).toBe(true);
  });
});
