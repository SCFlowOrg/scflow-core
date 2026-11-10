import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runScflow } from "../src/scflow.js";

const moduleYaml = `
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
`;

const temporary: string[] = [];
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workspaceDir() {
  const root = mkdtempSync(join(tmpdir(), "scflow-"));
  temporary.push(root);
  const modules = join(root, "modules");
  mkdirSync(join(modules, "tasks"), { recursive: true });
  writeFileSync(join(modules, "tasks", "module.yaml"), moduleYaml);
  return { root, modules, project: join(root, "project") };
}

async function scflow(args: string[], input: string[] = []) {
  const out: string[] = [];
  const err: string[] = [];
  async function* lines() {
    yield* input;
  }
  const code = await runScflow(args, {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    lines: lines(),
  });
  const parsed = out.map((line) => {
    try {
      return JSON.parse(line) as Record<string, unknown>;
    } catch {
      return line;
    }
  });
  return { code, out: parsed, err, first: parsed[0] as Record<string, unknown> & unknown[] };
}

async function created() {
  const dirs = workspaceDir();
  const result = await scflow([
    dirs.project,
    "create",
    "--type",
    "acme:tasks",
    "--title",
    "Demo",
    "--module",
    "acme:tasks",
    "--modules",
    dirs.modules,
  ]);
  expect(result.code).toBe(0);
  return dirs;
}

function snapshot(project: string): [string, string][] {
  return readdirSync(project)
    .sort()
    .map((name) => [name, readFileSync(join(project, name), "utf8")]);
}

const run = (d: { project: string; modules: string }, action: string, params: unknown) =>
  scflow([d.project, "run", action, JSON.stringify(params), "--modules", d.modules]);
const query = (d: { project: string; modules: string }) =>
  scflow([d.project, "query", "tasks.task", "--modules", d.modules]);

describe("languages", () => {
  const languages = (d: { project: string; modules: string }, ...args: string[]) =>
    scflow([d.project, "languages", ...args, "--modules", d.modules]);

  it("reads [] for a project that does not state them", async () => {
    const dirs = await created();
    expect((await languages(dirs)).first).toEqual({ languages: [] });
  });

  it("is seeded by create --language, in order", async () => {
    const dirs = workspaceDir();
    const result = await scflow([
      dirs.project, "create", "--type", "acme:tasks", "--title", "Demo", "--module", "acme:tasks",
      "--language", "fr", "--language", "en", "--modules", dirs.modules,
    ]);
    expect(result.code).toBe(0);
    expect((await languages(dirs)).first).toEqual({ languages: ["fr", "en"] });
  });

  it("sets the list, saves it, and refuses a duplicate", async () => {
    const dirs = await created();
    const set = await languages(dirs, '["de","fr"]');
    expect(set.first).toMatchObject({ languages: ["de", "fr"], changed: true });
    expect((await languages(dirs)).first).toEqual({ languages: ["de", "fr"] });
    const refused = await languages(dirs, '["fr","fr"]');
    expect(refused.code).toBe(1);
    expect(JSON.parse(refused.err[0] as string).error.code).toBe("constraint_violation");
    expect((await languages(dirs)).first).toEqual({ languages: ["de", "fr"] });
  });

  it("needs a JSON array", async () => {
    const dirs = await created();
    expect((await languages(dirs, '"fr"')).code).toBe(2);
  });

  it("is a command of the shell, undone by undo", async () => {
    const dirs = await created();
    const shell = await scflow([dirs.project, "shell", "--modules", dirs.modules], ['languages ["fr", "en"]', "languages", "undo", "languages", "exit"]);
    expect(shell.out).toEqual([
      { languages: ["fr", "en"], changed: true },
      { languages: ["fr", "en"] },
      { undo: true },
      { languages: [] },
    ]);
  });
});

describe("create", () => {
  it("saves a project", async () => {
    const dirs = await created();
    expect(existsSync(join(dirs.project, "project.json"))).toBe(true);
  });

  it("refuses a project already there", async () => {
    const dirs = await created();
    const again = await scflow([
      dirs.project, "create", "--type", "a:b", "--title", "T", "--module", "acme:tasks", "--modules", dirs.modules,
    ]);
    expect(again.code).toBe(1);
    expect(JSON.parse(again.err[0] as string).error.code).toBe("dataset_already_exists");
  });
});

describe("run", () => {
  it("changes the project on disk", async () => {
    const dirs = await created();
    const result = await run(dirs, "tasks/create_task", { title: "One" });
    expect(result.code).toBe(0);
    expect(result.first.changed).toBe(true);
    expect(result.first.written).toEqual(["data.json"]);
    expect(((await query(dirs)).first as unknown as { title: string }[])[0]?.title).toBe("One");
  });

  it("keeps a section it does not know", async () => {
    const dirs = await created();
    writeFileSync(join(dirs.project, "ui.json"), '{"version":1}');
    writeFileSync(join(dirs.project, "notes.txt"), "kept");
    await run(dirs, "tasks/create_task", { title: "One" });
    expect(readFileSync(join(dirs.project, "ui.json"), "utf8")).toBe('{"version":1}');
    expect(readFileSync(join(dirs.project, "notes.txt"), "utf8")).toBe("kept");
  });

  it("refuses bad parameters and leaves the bytes alone", async () => {
    const dirs = await created();
    const before = snapshot(dirs.project);
    const result = await run(dirs, "tasks/create_task", { title: 12 });
    expect(result.code).toBe(1);
    expect(JSON.parse(result.err[0] as string).error.code).toBe("invalid_parameters");
    expect(snapshot(dirs.project)).toEqual(before);
  });

  it("is read only when the module is absent", async () => {
    const dirs = await created();
    const result = await scflow([dirs.project, "run", "tasks/create_task", '{"title":"x"}']);
    expect(result.code).toBe(1);
  });

  it("refuses parameters that are not JSON", async () => {
    const dirs = await created();
    const result = await scflow([dirs.project, "run", "tasks/create_task", "{", "--modules", dirs.modules]);
    expect(result.code).toBe(2);
  });
});

describe("reads", () => {
  it("lists the actions, and changes no byte", async () => {
    const dirs = await created();
    const before = snapshot(dirs.project);
    const result = await scflow([dirs.project, "actions", "--modules", dirs.modules]);
    expect((result.first as unknown as { id: string }[]).map((a) => a.id)).toContain("tasks/create_task");
    await query(dirs);
    expect(snapshot(dirs.project)).toEqual(before);
  });

  it("filters a query", async () => {
    const dirs = await created();
    await run(dirs, "tasks/create_task", { title: "One" });
    await run(dirs, "tasks/create_task", { title: "Two" });
    const result = await scflow([
      dirs.project, "query", "tasks.task", '{"title":"Two"}', "--modules", dirs.modules,
    ]);
    expect((result.first as unknown as unknown[]).length).toBe(1);
  });
});

describe("shell", () => {
  it("runs, undoes and saves", async () => {
    const dirs = await created();
    const result = await scflow(
      [dirs.project, "shell", "--modules", dirs.modules],
      [
        'run tasks/create_task {"title":"A"}',
        'run tasks/create_task {"title":"B"}',
        "undo",
        "history",
        "save",
        "exit",
      ],
    );
    expect(result.code).toBe(0);
    const rows = (await query(dirs)).first as unknown as { title: string }[];
    expect(rows.map((row) => row.title)).toEqual(["A"]);
  });

  it("goes on after a refusal", async () => {
    const dirs = await created();
    const result = await scflow(
      [dirs.project, "shell", "--modules", dirs.modules],
      ["run tasks/nothing {}", 'run tasks/create_task {"title":"A"}', "save"],
    );
    expect(result.err.length).toBe(1);
    expect(((await query(dirs)).first as unknown as unknown[]).length).toBe(1);
  });

  it("says when the input ends with changes not saved, and does not save", async () => {
    const dirs = await created();
    const before = snapshot(dirs.project);
    const result = await scflow(
      [dirs.project, "shell", "--modules", dirs.modules],
      ['run tasks/create_task {"title":"A"}'],
    );
    expect(result.err.join(" ")).toMatch(/not saved/);
    expect(snapshot(dirs.project)).toEqual(before);
  });
});

describe("the command line", () => {
  it.each([[[]], [["only-a-path"]], [["p", "nothing"]], [["p", "run"]]])("refuses %j", async (args) => {
    expect((await scflow(args as string[])).code).toBe(2);
  });
});
