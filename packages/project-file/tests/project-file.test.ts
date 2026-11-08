import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createProject,
  createSectionRegistry,
  readFolder,
  readSingleFile,
  writeFolder,
  writeSingleFile,
  type Project,
  type ProjectFileError,
} from "../src/index.js";
import { readProject, writeProject } from "../src/node.js";

const samples = resolve(__dirname, "../../conformance/samples/project-file");
const singleSample = readFileSync(join(samples, "single-file.json"), "utf8");

const temporary: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "project-file-"));
  temporary.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function copyOfFolderSample(): string {
  const dir = join(tempDir(), "copy");
  cpSync(join(samples, "folder"), dir, { recursive: true });
  return dir;
}

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return (error as ProjectFileError).code;
  }
  return undefined;
}

const text = (value: string) => new TextEncoder().encode(value);
const decoded = (value: Uint8Array | undefined) => new TextDecoder().decode(value);
const envelope = '{"format":"scflow-project","version":1,"type":"a:b","title":"T"}';

describe("samples", () => {
  it("reads and writes the single file back to identical bytes", () => {
    expect(writeSingleFile(readSingleFile(singleSample))).toBe(singleSample);
  });

  it("gives the same content in both shapes", async () => {
    const single = readSingleFile(singleSample);
    const folder = await readProject(join(samples, "folder"));
    expect([...folder.sections].sort()).toEqual([...single.sections].sort());
    expect(folder.type).toBe(single.type);
    expect(folder.title).toBe(single.title);
  });

  it("writes a folder from the single file with the bytes of the sample", async () => {
    const out = join(tempDir(), "out");
    await writeProject(out, readSingleFile(singleSample), { shape: "folder" });
    for (const name of ["project", "modules", "model", "data", "ui", "unknown-tool"]) {
      expect(readFileSync(join(out, `${name}.json`), "utf8")).toBe(
        readFileSync(join(samples, "folder", `${name}.json`), "utf8"),
      );
    }
  });

  it("writes the single file from the folder with the bytes of the sample", async () => {
    const folder = await readProject(join(samples, "folder"));
    expect(writeSingleFile(folder)).toBe(singleSample);
  });

  it("keeps an unknown sub-folder", async () => {
    const dir = copyOfFolderSample();
    const result = await writeProject(dir, await readProject(dir));
    expect(result).toEqual({ written: [], removed: [] });
    expect(readFileSync(join(dir, "unknown-folder/notes.txt"), "utf8")).toContain("keeps this file");
  });
});

describe("bytes", () => {
  it("keeps the bytes of a single file formatted by another writer", () => {
    const original = '{"format":"scflow-project","version":1,"type":"a:b","title":"T","x":{"n":1.0}}';
    expect(writeSingleFile(readSingleFile(original))).toBe(original);
  });

  it("orders the sections on a change: document sections, then sorted", () => {
    const project = createProject({ type: "a:b", title: "T" });
    for (const key of ["zeta", "data", "alpha", "model", "modules"]) project.sections.set(key, {});
    expect(Object.keys(JSON.parse(writeSingleFile(project)))).toEqual([
      "format",
      "version",
      "type",
      "title",
      "modules",
      "model",
      "data",
      "alpha",
      "zeta",
    ]);
  });

  it("ends with one line feed and uses no carriage return", () => {
    const written = writeSingleFile(createProject({ type: "a:b", title: "T" }));
    expect(written.endsWith("}\n")).toBe(true);
    expect(written).not.toContain("\r");
  });

  it("touches only the file of the changed section", () => {
    const project = readFolder(
      new Map([
        ["project.json", text(envelope)],
        ["a.json", text('{"v":1}')],
        ["b.json", text('{ "v" : 2 }')],
      ]),
    );
    project.sections.set("a", { v: 9 });
    const out = writeFolder(project);
    expect(decoded(out.files.get("b.json"))).toBe('{ "v" : 2 }');
    expect(decoded(out.files.get("project.json"))).toBe(envelope);
    expect(decoded(out.files.get("a.json"))).toBe('{\n  "v": 9\n}\n');
  });

  it("does not rewrite an unchanged folder", async () => {
    const dir = copyOfFolderSample();
    const before = statSync(join(dir, "data.json")).mtimeMs;
    const result = await writeProject(dir, await readProject(dir));
    expect(result.written).toEqual([]);
    expect(statSync(join(dir, "data.json")).mtimeMs).toBe(before);
  });

  it("does not rewrite an unchanged single file", async () => {
    const path = join(tempDir(), "p.json");
    writeFileSync(path, singleSample);
    expect(await writeProject(path, await readProject(path))).toEqual({ written: [], removed: [] });
  });
});

describe("folder", () => {
  it("keeps a .json file that is not valid JSON and nobody declares", () => {
    const bad = text("{ not json");
    const project = readFolder(
      new Map([
        ["project.json", text(envelope)],
        ["notes.json", bad],
      ]),
    );
    expect(project.sections.has("notes")).toBe(false);
    expect(writeFolder(project).files.get("notes.json")).toEqual(bad);
  });

  it("refuses invalid JSON in a declared or a document section", () => {
    const sections = createSectionRegistry([{ key: "ui", owner: "documents" }]);
    for (const name of ["ui.json", "data.json"]) {
      const files = new Map([
        ["project.json", text(envelope)],
        [name, text("{")],
      ]);
      expect(codeOf(() => readFolder(files, { sections }))).toBe("invalid_project");
    }
  });

  it("removes the file of a removed section and no other", async () => {
    const dir = copyOfFolderSample();
    const project = await readProject(dir);
    project.sections.delete("ui");
    expect((await writeProject(dir, project)).removed).toEqual(["ui.json"]);
    expect(existsSync(join(dir, "ui.json"))).toBe(false);
    expect(existsSync(join(dir, "unknown-tool.json"))).toBe(true);
  });

  it("lets an owner organize a sub-folder", () => {
    const sections = createSectionRegistry([
      {
        key: "cards",
        owner: "t",
        folder: {
          read: (files) => [...files.keys()].sort(),
          write: (value) => new Map((value as string[]).map((name) => [name, text("x")])),
        },
      },
    ]);
    const project = readFolder(
      new Map([
        ["project.json", text(envelope)],
        ["cards/a.txt", text("x")],
        ["cards/b.txt", text("x")],
      ]),
      { sections },
    );
    expect(project.sections.get("cards")).toEqual(["a.txt", "b.txt"]);
    project.sections.set("cards", ["b.txt"]);
    const out = writeFolder(project, { sections });
    expect([...out.files.keys()]).toContain("cards/b.txt");
    expect(out.removed).toEqual(["cards/a.txt"]);
  });

  it("refuses a section key that cannot name a file", () => {
    for (const key of ["../evil", "a/b", "a\\b", "..", "project", "", "a:b"]) {
      const project = createProject({ type: "a:b", title: "T" });
      project.sections.set(key, {});
      expect(codeOf(() => writeFolder(project))).toBe("invalid_section_key");
    }
  });

  it("refuses a folder file that leaves the folder", () => {
    for (const path of ["../x", "/x", "a/../../x", "C:/x", "a\\x"]) {
      const project = createProject({ type: "a:b", title: "T" });
      project.files.set(path, text("x"));
      expect(codeOf(() => writeFolder(project))).toBe("invalid_file_path");
    }
  });

  it("does not read .git", async () => {
    const dir = copyOfFolderSample();
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, ".git/config"), "x");
    expect([...(await readProject(dir)).files.keys()]).toEqual(["unknown-folder/notes.txt"]);
  });
});

describe("envelope", () => {
  it.each([
    ['{"format":"other","version":1,"type":"a:b","title":"T"}', "not_a_project"],
    ['{"format":"scflow-project","version":2,"type":"a:b","title":"T"}', "unsupported_version"],
    ['{"format":"scflow-project","version":1,"title":"T"}', "invalid_project"],
    ['{"format":"scflow-project","version":1,"type":"a:b"}', "invalid_project"],
    ["{", "invalid_project"],
    ["[]", "not_a_project"],
  ])("refuses %s", (source, code) => {
    expect(codeOf(() => readSingleFile(source))).toBe(code);
  });

  it("refuses a folder without project.json", () => {
    expect(codeOf(() => readFolder(new Map()))).toBe("not_a_project");
  });

  it("refuses a key of project.json that is not in the envelope", () => {
    const body = '{"format":"scflow-project","version":1,"type":"a:b","title":"T","extra":1}';
    expect(codeOf(() => readFolder(new Map([["project.json", text(body)]])))).toBe("invalid_project");
  });

  it("reads a file with a byte order mark", () => {
    expect(readSingleFile(`\uFEFF${envelope}`).type).toBe("a:b");
  });

  it("keeps a section named __proto__ as a section", () => {
    const project: Project = readSingleFile(
      '{"format":"scflow-project","version":1,"type":"a:b","title":"T","__proto__":{"x":1}}',
    );
    expect(project.sections.get("__proto__")).toEqual({ x: 1 });
    project.title = "U";
    const written = JSON.parse(writeSingleFile(project)) as Record<string, unknown>;
    expect(Object.keys(written)).toContain("__proto__");
    expect(written.x).toBeUndefined();
  });
});

describe("sections", () => {
  it("refuses two owners of one key", () => {
    expect(
      codeOf(() =>
        createSectionRegistry([
          { key: "ui", owner: "a" },
          { key: "ui", owner: "b" },
        ]),
      ),
    ).toBe("section_clash");
  });

  const withUi = (version: number) =>
    `{"format":"scflow-project","version":1,"type":"a:b","title":"T","ui":{"version":${version},"v":"old"}}`;

  it("migrates an older section through its owner, and rewrites it", () => {
    const sections = createSectionRegistry([
      { key: "ui", owner: "d", version: 2, migrate: (value) => ({ ...(value as object), version: 2, v: "new" }) },
    ]);
    const project = readSingleFile(withUi(1), { sections });
    expect(project.sections.get("ui")).toEqual({ version: 2, v: "new" });
    expect(writeSingleFile(project)).toContain('"new"');
  });

  it("refuses a newer section, and an older one with no migration", () => {
    const sections = createSectionRegistry([{ key: "ui", owner: "d", version: 2 }]);
    expect(codeOf(() => readSingleFile(withUi(3), { sections }))).toBe("unsupported_section_version");
    expect(codeOf(() => readSingleFile(withUi(1), { sections }))).toBe("unsupported_section_version");
  });

  it("reads a section with no declaration as it is", () => {
    expect(readSingleFile(withUi(9)).sections.get("ui")).toEqual({ version: 9, v: "old" });
  });
});

describe("neutrality", () => {
  it("imports no Node built-in in the main entry", () => {
    const source = readFileSync(resolve(__dirname, "../src/index.ts"), "utf8");
    expect(source).not.toMatch(/from "node:|require\(/);
  });
});
