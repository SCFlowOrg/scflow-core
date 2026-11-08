import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { moduleDigest, readModuleManifest, type ModuleManifest } from "@scfloworg/core";
import { createEnvironment as createDiskEnvironment } from "@scfloworg/environment";
import { createEnvironment } from "@scfloworg/environment/browser";
import { createFileFormat } from "@scfloworg/format-file";
import { createSectionsFormat, type ProjectContent } from "@scfloworg/format-file/browser";
import { defineModule } from "@scfloworg/module";
import { readProject } from "@scfloworg/project-file/node";
import { createWorkspace } from "../src/index.js";
import { createSectionsWorkspace, type SectionsDocument } from "../src/browser.js";

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

const packagesRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function setup() {
  const file = createSectionsFormat();
  const environment = createEnvironment({ formats: [file] });
  environment.modules.install(defineModule(manifest()));
  return { environment, file, workspace: createSectionsWorkspace({ environment, file }) };
}

const newDocument = (workspace: ReturnType<typeof setup>["workspace"], id = "doc") =>
  workspace.create({ id, modules: ["acme:tasks"], type: "acme:tasks", title: "Demo" });

async function titles(doc: SectionsDocument): Promise<string[]> {
  const rows = (await doc.dataset.query({ query: "tasks.task" })).after as { title: string }[];
  return rows.map((row) => row.title).sort();
}

const add = (doc: SectionsDocument, title: string) => doc.run("tasks/create_task", { title });

async function codeOf(run: () => unknown): Promise<string | undefined> {
  try {
    await run();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
}

async function saved(): Promise<ProjectContent> {
  const context = setup();
  const doc = await newDocument(context.workspace, "seed");
  await add(doc, "First");
  return doc.content();
}

const temporary: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("a document on in-memory sections", () => {
  it("runs an action, undoes it, and gives the sections a disk save writes", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-01-01T00:00:00Z") });

    const directory = mkdtempSync(join(tmpdir(), "workspace-browser-"));
    temporary.push(directory);
    const path = join(directory, "project.json");
    const diskFile = createFileFormat();
    const diskEnvironment = createDiskEnvironment({ formats: [diskFile] });
    diskEnvironment.modules.install(defineModule(manifest()));
    const disk = await createWorkspace({ environment: diskEnvironment, file: diskFile }).create({
      path,
      modules: ["acme:tasks"],
      type: "acme:tasks",
      title: "Demo",
      name: "demo",
    });

    const { workspace } = setup();
    const memory = await workspace.create({
      id: "demo",
      modules: ["acme:tasks"],
      type: "acme:tasks",
      title: "Demo",
      name: "demo",
    });

    const uuids = vi.spyOn(globalThis.crypto, "randomUUID");
    for (const doc of [disk, memory]) {
      // Both documents draw the same ids, so that only what differs by storage can differ.
      let drawn = 0;
      uuids.mockImplementation(() => `00000000-0000-4000-8000-${String(++drawn).padStart(12, "0")}` as never);
      await doc.run("tasks/create_task", { title: "Audit" });
      await doc.run("tasks/create_task", { title: "Ship" });
      await doc.undo();
      doc.setSection("notes", { text: "kept" });
    }
    await disk.save();

    const written = await readProject(path);
    const content = await memory.content();
    expect(await titles(memory)).toEqual(["Audit"]);
    expect(content.type).toBe(written.type);
    expect(content.title).toBe(written.title);
    expect(Object.fromEntries(content.sections)).toEqual(Object.fromEntries(written.sections));
  });

  it("opens the sections it gave, and keeps what the host wrote", async () => {
    const content = await saved();
    const { workspace } = setup();
    const doc = await workspace.open("again", content);
    expect(await titles(doc)).toEqual(["First"]);
    expect(doc.id).toBe("again");
    expect(doc.title).toBe("Demo");
    expect(workspace.get("again")).toBe(doc);
    expect(workspace.list()).toEqual([doc]);
    expect(Object.fromEntries((await doc.content()).sections)).toEqual(Object.fromEntries(content.sections));
  });

  it("copies the sections in and out", async () => {
    const content = await saved();
    const { workspace } = setup();
    const doc = await workspace.open("again", content);
    await add(doc, "Second");
    expect(((content.sections.get("data") as { instances: Record<string, unknown[]> }).instances["tasks.task"] ?? []).length).toBe(1);

    const out = await doc.content();
    (out.sections.get("data") as { name: string }).name = "changed";
    expect(((await doc.content()).sections.get("data") as { name: string }).name).not.toBe("changed");
  });

  it("runs the phases of a transaction as a document from disk", async () => {
    const { workspace } = setup();
    const doc = await newDocument(workspace);

    await doc.begin("Two");
    await add(doc, "A");
    expect(await codeOf(() => doc.content())).toBe("transaction_open");
    expect(await codeOf(() => doc.begin("Other"))).toBe("transaction_open");
    expect(await doc.prepare()).toEqual({ changed: true });
    await doc.commit();
    expect(doc.history().undo).toEqual(["Two"]);

    await doc.begin("Dropped");
    await add(doc, "B");
    await doc.rollback();
    expect(await titles(doc)).toEqual(["A"]);
    expect(await codeOf(() => doc.commit())).toBe("no_transaction");

    expect(await doc.undo()).toBe(true);
    expect(await titles(doc)).toEqual([]);
    expect(await doc.redo()).toBe(true);
    expect(await titles(doc)).toEqual(["A"]);
  });

  it("opens read only: writes are refused, the sections can be read", async () => {
    const content = await saved();
    const { workspace } = setup();
    const doc = await workspace.open("again", content, { readOnly: true });
    expect(doc.readOnly).toBe(true);
    expect(await codeOf(() => doc.begin("x"))).toBe("read_only_document");
    expect(await codeOf(() => doc.undo())).toBe("read_only_document");
    expect(await codeOf(() => doc.setSection("notes", {}))).toBe("read_only_document");
    expect(await codeOf(() => add(doc, "No"))).toBe("read_only_dataset");
    expect((await doc.content()).sections.has("data")).toBe(true);
  });

  it("opens read only a document with a hand-edited manifest", async () => {
    const content = await saved();
    const model = content.sections.get("model") as Record<string, ModuleManifest>;
    const edited = { ...model["acme:tasks"], title: "Changed" } as ModuleManifest;
    expect(await moduleDigest(edited)).not.toBe(await moduleDigest(model["acme:tasks"]));
    content.sections.set("model", { "acme:tasks": edited });

    const doc = await setup().workspace.open("again", content);
    expect(doc.readOnly).toBe(true);
    expect(doc.handEdited).toEqual(["acme:tasks"]);
  });

  it("refuses to open an id already open, and forgets a closed document", async () => {
    const content = await saved();
    const { workspace } = setup();
    const doc = await workspace.open("again", content);
    expect(await codeOf(() => workspace.open("again", content))).toBe("document_open");
    await doc.close();
    expect(workspace.get("again")).toBeUndefined();
    expect(await titles(await workspace.open("again", content))).toEqual(["First"]);
  });

  it("refuses a format the environment does not have", () => {
    const file = createSectionsFormat();
    const environment = createEnvironment({ formats: [createSectionsFormat({ name: "other" })] });
    expect(() => createSectionsWorkspace({ environment, file })).toThrowError(/not one of the environment/);
  });

  it("refuses to load a module from a folder", async () => {
    expect(await codeOf(() => setup().environment.modules.load("./anywhere"))).toBe("constraint_violation");
  });
});

/** The file of a `@scfloworg` entry, in the sources of its package. */
function entryFile(specifier: string): string {
  const [, name, subpath] = /^@scfloworg\/([^/]+)(\/.*)?$/.exec(specifier) as RegExpExecArray;
  const folder = join(packagesRoot, name);
  const { exports: entries } = JSON.parse(readFileSync(join(folder, "package.json"), "utf8")) as {
    exports: Record<string, { default: string }>;
  };
  const target = entries[`.${subpath ?? ""}`];
  if (!target) throw new Error(`${specifier} is not an entry of its package`);
  return join(folder, target.default.replace("./dist/", "src/").replace(/\.js$/, ".ts"));
}

/** What `file` imports at run time, static and dynamic. A type-only import is erased. */
function importsOf(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const forms = /^\s*(?:import|export)\s+(?!type\b)(?:[^'";]*?\sfrom\s+)?["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/gm;
  return [...text.matchAll(forms)].map((match) => match[1] ?? match[2]);
}

/** The modules reached from `roots`, and every import of something outside the repo. */
function reach(roots: string[]): { files: Set<string>; external: Set<string> } {
  const files = new Set<string>();
  const external = new Set<string>();
  const pending = [...roots];
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (files.has(file)) continue;
    expect(existsSync(file), file).toBe(true);
    files.add(file);
    for (const specifier of importsOf(file)) {
      if (specifier.startsWith(".")) pending.push(resolve(dirname(file), specifier.replace(/\.js$/, ".ts")));
      else if (specifier.startsWith("@scfloworg/")) pending.push(entryFile(specifier));
      else external.add(specifier);
    }
  }
  return { files, external };
}

describe("the browser entries", () => {
  const entries = [
    "@scfloworg/workspace/browser",
    "@scfloworg/environment/browser",
    "@scfloworg/format-file/browser",
  ];

  it("reach no module of Node", () => {
    const { external } = reach(entries.map(entryFile));
    const node = [...external].filter((specifier) => specifier.startsWith("node:"));
    expect(node).toEqual([]);
    // An import without the prefix would escape the check above.
    const builtins = ["fs", "fs/promises", "path", "url", "os", "module", "crypto", "buffer", "process"];
    expect([...external].filter((specifier) => builtins.includes(specifier))).toEqual([]);
  });

  it("the check sees an entry that does reach Node", () => {
    const { external } = reach([entryFile("@scfloworg/format-file")]);
    expect([...external].some((specifier) => specifier.startsWith("node:"))).toBe(true);
  });
});
