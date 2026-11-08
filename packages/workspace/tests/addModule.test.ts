import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { moduleDigest, readModuleManifest } from "@scfloworg/core";
import { createEnvironment } from "@scfloworg/environment";
import { createEnvironment as createBrowserEnvironment } from "@scfloworg/environment/browser";
import { createFileFormat } from "@scfloworg/format-file";
import { createSectionsFormat } from "@scfloworg/format-file/browser";
import { defineModule } from "@scfloworg/module";
import { readProject } from "@scfloworg/project-file/node";
import { createSectionsWorkspace } from "../src/browser.js";
import { createWorkspace, type Document } from "../src/index.js";

const tasks = () =>
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

const base = () =>
  readModuleManifest(`
name: acme:base
namespace: base
version: 1.0.0
mcl: ^1.0
title: Base
dependencies:
  - module: acme:tasks
    version: ^1.0
schemas:
  - name: palette
    is_root:
    properties:
      - name: label
        type: string
`);

const graph = () =>
  readModuleManifest(`
name: acme:graph
namespace: graph
version: 1.0.0
mcl: ^1.0
title: Graph
dependencies:
  - module: acme:tasks
    version: ^1.0
  - module: acme:base
    version: ^1.0
schemas:
  - name: node_style
    facet_of: tasks.task
    properties:
      - name: color
        type: string
        default_value: blue
  - name: layout
    is_root:
    properties:
      - name: label
        type: string
`);

const temporary: string[] = [];
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function setup(): Promise<{ doc: Document; path: string; reopen: () => Promise<Document> }> {
  const directory = mkdtempSync(join(tmpdir(), "workspace-add-"));
  temporary.push(directory);
  const path = join(directory, "project");
  const make = () => {
    const file = createFileFormat();
    const environment = createEnvironment({ formats: [file] });
    for (const manifest of [tasks(), base(), graph()]) environment.modules.install(defineModule(manifest));
    return { environment, workspace: createWorkspace({ environment, file }) };
  };
  const { workspace } = make();
  const doc = await workspace.create({ path, modules: ["acme:tasks"], type: "acme:tasks", title: "Demo" });
  return {
    doc,
    path,
    reopen: () => make().workspace.open(path),
  };
}

const rows = async (doc: Document, query: string) => (await doc.dataset.query({ query })).after as Record<string, unknown>[];

async function codeOf(run: () => unknown): Promise<string | undefined> {
  try {
    await run();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
}

describe("adding a module to a document", () => {
  it("lists the module and its dependency, runs its actions, reads its facets, and saves it", async () => {
    const { doc, path, reopen } = await setup();
    await doc.run("tasks/create_task", { title: "Audit" });
    expect(doc.dataset.actions().some((action) => action.id === "graph/create_layout")).toBe(false);

    expect(await doc.addModule("acme:graph")).toEqual(["acme:base", "acme:graph"]);

    expect(doc.dataset.modules.map((module) => [module.module, module.state])).toEqual([
      ["acme:tasks", "current"],
      ["acme:base", "current"],
      ["acme:graph", "current"],
    ]);
    await doc.run("graph/create_layout", { label: "Main" });
    expect((await rows(doc, "graph.layout")).map((row) => row.label)).toEqual(["Main"]);
    expect(((await rows(doc, "tasks.task"))[0].graph as { color: string }).color).toBe("blue");
    expect(await doc.dataset.dump("json")).toContain("node_style");

    await doc.save();
    const project = await readProject(path);
    expect(Object.keys(project.sections.get("modules") as object)).toContain("acme:graph");
    expect(Object.keys(project.sections.get("model") as object)).toContain("acme:graph");
    expect(Object.keys((project.sections.get("data") as { instances: object }).instances)).not.toContain("graph.node_style");
    const again = await reopen();
    expect(again.dataset.modules.map((module) => module.module)).toContain("acme:graph");
  });

  it("stays out of the history, and earlier steps still undo and redo", async () => {
    const { doc } = await setup();
    await doc.run("tasks/create_task", { title: "Audit" });
    await doc.run("tasks/create_task", { title: "Ship" });
    await doc.undo();
    const before = doc.history();

    await doc.addModule("acme:graph");
    expect(doc.history()).toEqual(before);

    expect(await doc.redo()).toBe(true);
    expect(await rows(doc, "tasks.task")).toHaveLength(2);
    expect(await doc.undo()).toBe(true);
    expect(await doc.undo()).toBe(true);
    expect(await rows(doc, "tasks.task")).toEqual([]);
    expect(doc.dataset.modules.map((module) => module.module)).toContain("acme:graph");
  });

  it("does nothing the second time", async () => {
    const { doc } = await setup();
    await doc.addModule("acme:graph");
    expect(await doc.addModule("acme:graph")).toEqual([]);
  });

  it("refuses a module that is not installed", async () => {
    const { doc } = await setup();
    expect(await codeOf(() => doc.addModule("acme:nothing"))).toBe("key_not_found");
  });

  it("refuses a namespace conflict and leaves the document as it was", async () => {
    // The catalogue refuses a clash between installed modules: a local module is the other source of one.
    const local = readModuleManifest(`
name: local:graph
namespace: graph
version: 1.0.0
mcl: ^1.0
title: Local
schemas: []
`);
    const file = createSectionsFormat();
    const environment = createBrowserEnvironment({ formats: [file] });
    for (const manifest of [tasks(), base(), graph()]) environment.modules.install(defineModule(manifest));
    const workspace = createSectionsWorkspace({ environment, file });
    const created = await workspace.create({ id: "seed", modules: ["acme:tasks"], type: "acme:tasks", title: "Demo" });
    const content = await created.content();
    content.sections.set("modules", {
      ...(content.sections.get("modules") as object),
      "local:graph": { version: "1.0.0", digest: await moduleDigest(local) },
    });
    content.sections.set("model", { ...(content.sections.get("model") as object), "local:graph": local });

    const doc = await workspace.open("clash", content);
    expect(await codeOf(() => doc.addModule("acme:graph"))).toBe("namespace_conflict");
    expect(doc.dataset.modules.map((module) => module.module)).toEqual(["acme:tasks", "local:graph"]);
  });

  it("refuses during a transaction", async () => {
    const { doc } = await setup();
    await doc.begin("Open");
    expect(await codeOf(() => doc.addModule("acme:graph"))).toBe("transaction_open");
    await doc.rollback();
  });

  it("refuses on a read-only document and dataset", async () => {
    const { doc, path } = await setup();
    await doc.save();
    const file = createFileFormat();
    const environment = createEnvironment({ formats: [file] });
    for (const manifest of [tasks(), base(), graph()]) environment.modules.install(defineModule(manifest));
    const readOnly = await createWorkspace({ environment, file }).open(path, { readOnly: true });
    expect(await codeOf(() => readOnly.addModule("acme:graph"))).toBe("read_only_document");
    expect(await codeOf(() => readOnly.dataset.addModule("acme:graph"))).toBe("read_only_dataset");
  });
});
