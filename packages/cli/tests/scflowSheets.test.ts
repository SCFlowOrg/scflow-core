import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runScflow } from "../src/scflow.js";

const plantsYaml = `
name: acme:plants
namespace: plants
version: 1.0.0
mcl: ^1.0
title: Plants
schemas:
  - name: country
    is_root: true
    name_scope: []
    properties:
      - name: name
        type: localized_string
        min_length: 1
      - name: code
        type: string
  - name: city
    is_root: true
    name_scope: [country]
    checks:
      - name: capacity_not_negative
        when: { capacity: { exists: true } }
        require: { capacity: { gte: 0 } }
    properties:
      - name: name
        type: string
      - name: country
        type: country
        mandatory: true
      - name: capacity
        type: number
      - name: active
        type: boolean
      - name: labels
        type: string
        is_array: true
      - name: remark
        type: string
`;

const temporary: string[] = [];
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function folders() {
  const root = mkdtempSync(join(tmpdir(), "scflow-csv-"));
  temporary.push(root);
  const modules = join(root, "modules");
  mkdirSync(join(modules, "plants"), { recursive: true });
  writeFileSync(join(modules, "plants", "module.yaml"), plantsYaml);
  return { root, modules };
}

type Dirs = ReturnType<typeof folders>;

async function scflow(args: string[], input: string[] = []) {
  const out: string[] = [];
  const err: string[] = [];
  async function* lines() {
    yield* input;
  }
  const code = await runScflow(args, { out: (line) => out.push(line), err: (line) => err.push(line), lines: lines() });
  const parsed = out.map((line) => {
    try {
      return JSON.parse(line) as Record<string, any>;
    } catch {
      return line;
    }
  });
  return { code, out: parsed, err, first: parsed[0] as Record<string, any> };
}

interface Where {
  modules: string;
  key: string;
  type: string;
}

async function create(dirs: Dirs, name: string, where: Where = { modules: dirs.modules, key: "acme:plants", type: "acme:plants" }) {
  const project = join(dirs.root, name);
  const result = await scflow([project, "create", "--type", where.type, "--title", name, "--module", where.key, "--language", "fr", "--language", "en", "--modules", where.modules]);
  expect(result.code).toBe(0);
  return project;
}

/** A project with two countries and three cities, one with a list, a number, a boolean and a text with quotes and a line break. */
async function seeded(dirs: Dirs, name = "source") {
  const project = await create(dirs, name);
  const run = async (action: string, params: unknown) => expect((await scflow([project, "run", action, JSON.stringify(params), "--modules", dirs.modules])).code).toBe(0);
  await run("plants/create_country", { name: { fr: "France", en: "France" }, code: "FR" });
  await run("plants/create_country", { name: { fr: "Allemagne", en: "Germany" } });
  await run("plants/create_city", { name: "Paris", country: "France", capacity: 12.5, active: true, labels: ["capital", "north"], remark: 'He said "hi", then\nleft' });
  await run("plants/create_city", { name: "Lyon", country: "France" });
  await run("plants/create_city", { name: "Lyon", country: "Germany", capacity: 3 });
  return project;
}

const exportTo = (dirs: Dirs, project: string, folder: string, ...more: string[]) => scflow([project, "export", folder, "--modules", dirs.modules, ...more]);
const importFrom = (dirs: Dirs, project: string, ...args: string[]) => scflow([project, "import", ...args, "--modules", dirs.modules]);

const filesOf = (folder: string): [string, string][] =>
  readdirSync(folder)
    .sort()
    .map((name) => [name, readFileSync(join(folder, name), "utf8")]);

describe("scflow export", () => {
  it("writes one CSV per sheet, named after it, with a header, and prints { files, skipped }", async () => {
    const dirs = folders();
    const project = await seeded(dirs);
    const folder = join(dirs.root, "out");
    const result = await exportTo(dirs, project, folder);
    expect(result.code).toBe(0);
    expect(result.first).toEqual({ files: ["country.csv", "city.csv"], skipped: [] });
    expect(readdirSync(folder).sort()).toEqual(["city.csv", "country.csv"]);
    const text = Object.fromEntries(filesOf(folder));
    expect(text["country.csv"]).toBe("name (fr),name (en),code\nAllemagne,Germany,\nFrance,France,FR\n");
    expect(text["city.csv"]).toBe(
      'name,country,capacity,active,labels,remark\nLyon,Allemagne,3,false,,\nLyon,France,0,false,,\nParis,France,12.5,true,capital; north,"He said ""hi"", then\nleft"\n',
    );
  });

  it("opens the project read only: nothing in it changes", async () => {
    const dirs = folders();
    const project = await seeded(dirs);
    const before = filesOf(project);
    expect((await exportTo(dirs, project, join(dirs.root, "out"))).code).toBe(0);
    expect(filesOf(project)).toEqual(before);
  });

  it("keeps only the sheets --schema names", async () => {
    const dirs = folders();
    const project = await seeded(dirs);
    const folder = join(dirs.root, "out");
    const result = await exportTo(dirs, project, folder, "--schema", "country");
    expect(result.first.files).toEqual(["country.csv"]);
    expect(readdirSync(folder)).toEqual(["country.csv"]);
    expect((await exportTo(dirs, project, join(dirs.root, "both"), "--schema", "city", "--schema", "country")).first.files).toEqual(["country.csv", "city.csv"]);
  });

  it("refuses an unknown schema as every refusal, and writes nothing", async () => {
    const dirs = folders();
    const project = await seeded(dirs);
    const folder = join(dirs.root, "out");
    const result = await exportTo(dirs, project, folder, "--schema", "nope");
    expect(result.code).toBe(1);
    expect(JSON.parse(result.err[0] as string).error.code).toBe("unknown_sheet");
    expect(() => readdirSync(folder)).toThrow();
  });

  it("writes with --separator, and quotes against it", async () => {
    const dirs = folders();
    const project = await seeded(dirs);
    const folder = join(dirs.root, "out");
    expect((await exportTo(dirs, project, folder, "--separator", ";")).code).toBe(0);
    const text = Object.fromEntries(filesOf(folder));
    expect(text["country.csv"]).toBe("name (fr);name (en);code\nAllemagne;Germany;\nFrance;France;FR\n");
    expect(text["city.csv"]).toContain('Paris;France;12.5;true;"capital; north";"He said ""hi"", then\nleft"\n');
  });

  it("takes --list-separator, so a list needs no quote", async () => {
    const dirs = folders();
    const project = await seeded(dirs);
    const folder = join(dirs.root, "out");
    expect((await exportTo(dirs, project, folder, "--separator", ";", "--list-separator", "|")).code).toBe(0);
    expect(Object.fromEntries(filesOf(folder))["city.csv"]).toContain("Paris;France;12.5;true;capital| north;");
  });

  it("fails as the package does when a list value holds the list separator", async () => {
    const dirs = folders();
    const project = await seeded(dirs);
    const result = await exportTo(dirs, project, join(dirs.root, "out"), "--list-separator", "a");
    expect(result.code).toBe(1);
    expect(JSON.parse(result.err[0] as string).error.code).toBe("separator_in_value");
  });

  it("is a wrong command line without a folder, or with a separator that is not one character", async () => {
    const dirs = folders();
    const project = await seeded(dirs);
    expect((await scflow([project, "export", "--modules", dirs.modules])).code).toBe(2);
    expect((await exportTo(dirs, project, join(dirs.root, "out"), "--separator", "ab")).code).toBe(2);
    expect((await exportTo(dirs, project, join(dirs.root, "out"), "--separator", '"')).code).toBe(2);
  });
});

describe("scflow import", () => {
  it("rebuilds an empty project from the files of another: the files exported again are identical", async () => {
    const dirs = folders();
    const source = await seeded(dirs);
    const first = join(dirs.root, "first");
    await exportTo(dirs, source, first);

    const target = await create(dirs, "target");
    const result = await importFrom(dirs, target, first);
    expect(result.code).toBe(0);
    expect(result.first).toMatchObject({ ok: true, dryRun: false, applied: true, created: 5, updated: 0, unchanged: 0, refused: 0 });
    expect(result.first.written.length).toBeGreaterThan(0);

    const second = join(dirs.root, "second");
    await exportTo(dirs, target, second);
    expect(filesOf(second)).toEqual(filesOf(first));
  });

  it("takes the sheet from the name of each file, and accepts files as well as a folder", async () => {
    const dirs = folders();
    const source = await seeded(dirs);
    const out = join(dirs.root, "out");
    await exportTo(dirs, source, out);
    writeFileSync(join(out, "readme.txt"), "not a sheet");
    const target = await create(dirs, "target");
    const result = await importFrom(dirs, target, join(out, "country.csv"), join(out, "city.csv"));
    expect(result.code).toBe(0);
    expect(result.first.created).toBe(5);
    const again = await create(dirs, "again");
    expect((await importFrom(dirs, again, out)).first.created).toBe(5);
  });

  it("imports into itself: every row is unchanged and nothing is saved", async () => {
    const dirs = folders();
    const project = await seeded(dirs);
    const out = join(dirs.root, "out");
    await exportTo(dirs, project, out);
    const before = filesOf(project);
    const result = await importFrom(dirs, project, out);
    expect(result.code).toBe(0);
    expect(result.first).toMatchObject({ ok: true, created: 0, updated: 0, unchanged: 5, refused: 0, written: [] });
    expect(filesOf(project)).toEqual(before);
  });

  it("updates what changed, and keeps the rest", async () => {
    const dirs = folders();
    const project = await seeded(dirs);
    const out = join(dirs.root, "out");
    await exportTo(dirs, project, out);
    const file = join(out, "city.csv");
    writeFileSync(file, readFileSync(file, "utf8").replace("Paris,France,12.5", "Paris,France,20"));
    const result = await importFrom(dirs, project, file);
    expect(result.first).toMatchObject({ ok: true, created: 0, updated: 1, unchanged: 2 });
    expect(result.first.written.length).toBeGreaterThan(0);
    const cities = (await scflow([project, "query", "plants.city", "--modules", dirs.modules])).first as unknown as { name: string; capacity?: number }[];
    expect(cities.find((c) => c.name === "Paris")?.capacity).toBe(20);
  });

  it("reads another separator, a byte order mark and CRLF", async () => {
    const dirs = folders();
    const target = await create(dirs, "target");
    const file = join(dirs.root, "country.csv");
    writeFileSync(file, "﻿name (fr);name (en);code\r\nFrance;France;FR\r\n");
    const result = await importFrom(dirs, target, file, "--separator", ";");
    expect(result.code).toBe(0);
    expect(result.first).toMatchObject({ ok: true, created: 1 });
  });

  it("reads lists with --list-separator", async () => {
    const dirs = folders();
    const target = await create(dirs, "target");
    writeFileSync(join(dirs.root, "country.csv"), "name (fr),name (en)\nFrance,France\n");
    writeFileSync(join(dirs.root, "city.csv"), "name,country,labels\nParis,France,capital|north\n");
    const result = await importFrom(dirs, target, join(dirs.root, "country.csv"), join(dirs.root, "city.csv"), "--list-separator", "|");
    expect(result.first).toMatchObject({ ok: true, created: 2 });
    const cities = (await scflow([target, "query", "plants.city", "--modules", dirs.modules])).first as unknown as { labels: string[] }[];
    expect(cities[0]?.labels).toEqual(["capital", "north"]);
  });

  it("refuses the whole import when a row is refused: the report lists every row, nothing is saved, exit 1", async () => {
    const dirs = folders();
    const target = await create(dirs, "target");
    const before = filesOf(target);
    writeFileSync(join(dirs.root, "country.csv"), "name (fr),name (en)\nFrance,France\n");
    writeFileSync(join(dirs.root, "city.csv"), "name,country\nParis,France\nBerlin,Atlantis\n");
    const result = await importFrom(dirs, target, join(dirs.root, "country.csv"), join(dirs.root, "city.csv"));
    expect(result.code).toBe(1);
    expect(result.err).toEqual([]);
    expect(result.first).toMatchObject({ ok: false, applied: false, refused: 1, written: [] });
    expect(result.first.rows.map((r: any) => [r.sheet, r.line, r.status])).toEqual([
      ["country", 2, "create"],
      ["city", 2, "create"],
      ["city", 3, "refused"],
    ]);
    expect(result.first.rows[2].code).toBe("unresolved_reference");
    expect(filesOf(target)).toEqual(before);
  });

  it("with --dry-run writes nothing, and reports the rules of the model too", async () => {
    const dirs = folders();
    const target = await create(dirs, "target");
    const before = filesOf(target);
    writeFileSync(join(dirs.root, "country.csv"), "name (fr),name (en)\nFrance,France\n");
    writeFileSync(join(dirs.root, "city.csv"), "name,country,capacity\nParis,France,-1\n");
    const bad = await importFrom(dirs, target, join(dirs.root, "country.csv"), join(dirs.root, "city.csv"), "--dry-run");
    expect(bad.code).toBe(1);
    expect(bad.first).toMatchObject({ ok: false, dryRun: true, applied: false, written: [] });
    expect(bad.first.rows.find((r: any) => r.status === "refused").code).toBe("rule_violation");

    writeFileSync(join(dirs.root, "city.csv"), "name,country,capacity\nParis,France,1\n");
    const good = await importFrom(dirs, target, join(dirs.root, "country.csv"), join(dirs.root, "city.csv"), "--dry-run");
    expect(good.code).toBe(0);
    expect(good.first).toMatchObject({ ok: true, dryRun: true, applied: false, created: 2, written: [] });
    expect(filesOf(target)).toEqual(before);
  });

  it("refuses a file that cannot be read, a file with no header, and an unknown sheet, on the standard error, and exits 1", async () => {
    const dirs = folders();
    const target = await create(dirs, "target");
    const before = filesOf(target);

    const missing = await importFrom(dirs, target, join(dirs.root, "nowhere.csv"));
    expect(missing.code).toBe(1);
    expect(missing.out).toEqual([]);
    expect(JSON.parse(missing.err[0] as string).error.code).toBe("file_unreadable");

    writeFileSync(join(dirs.root, "country.csv"), "");
    const empty = await importFrom(dirs, target, join(dirs.root, "country.csv"));
    expect(empty.code).toBe(1);
    expect(JSON.parse(empty.err[0] as string).error.code).toBe("invalid_csv");

    writeFileSync(join(dirs.root, "planet.csv"), "name\nMars\n");
    const unknown = await importFrom(dirs, target, join(dirs.root, "planet.csv"));
    expect(unknown.code).toBe(1);
    expect(unknown.out).toEqual([]);
    expect(JSON.parse(unknown.err[0] as string).error.code).toBe("unknown_sheet");

    expect(filesOf(target)).toEqual(before);
  });

  it("is a wrong command line without a file, or for a folder with no .csv file", async () => {
    const dirs = folders();
    const target = await create(dirs, "target");
    expect((await scflow([target, "import", "--modules", dirs.modules])).code).toBe(2);
    mkdirSync(join(dirs.root, "empty"));
    expect((await importFrom(dirs, target, join(dirs.root, "empty"))).code).toBe(2);
  });

  it("is one undo step in the shell", async () => {
    const dirs = folders();
    const source = await seeded(dirs);
    const out = join(dirs.root, "out");
    await exportTo(dirs, source, out);
    const target = await create(dirs, "target");
    const shell = await scflow(
      [target, "shell", "--modules", dirs.modules],
      [`import ${out}`, "history", "query plants.city", "undo", "query plants.city", "redo", "query plants.city", "exit"],
    );
    expect(shell.out[0]).toMatchObject({ ok: true, created: 5 });
    expect(shell.out[1]).toEqual({ undo: ["Import sheets"], redo: [] });
    expect(shell.out[2]).toHaveLength(3);
    expect(shell.out[3]).toEqual({ undo: true });
    expect(shell.out[4]).toEqual([]);
    expect(shell.out[5]).toEqual({ redo: true });
    expect(shell.out[6]).toHaveLength(3);
  });

  it("exports in the shell too, and does not save an import there", async () => {
    const dirs = folders();
    const source = await seeded(dirs);
    const out = join(dirs.root, "out");
    const shell = await scflow([source, "shell", "--modules", dirs.modules], [`export ${out} --schema country`, "exit"]);
    expect(shell.out[0]).toEqual({ files: ["country.csv"], skipped: [] });

    const target = await create(dirs, "target");
    const before = filesOf(target);
    const kept = await scflow([target, "shell", "--modules", dirs.modules], [`import ${out}`, "exit"]);
    expect(kept.out[0]).toMatchObject({ ok: true, created: 2 });
    expect(kept.err.join("\n")).toContain("not saved");
    expect(filesOf(target)).toEqual(before);
  });
});

/** The folder of the module scflow:core, loaded with its built bundle. */
const scflowCore = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "module-scflow-core");

// Each test loads and checks the bundle of scflow:core, several times.
describe("a network of scflow:core through CSV files", { timeout: 60000 }, () => {
  it("is exported, and rebuilt from the files into the same files", async () => {
    const dirs = folders();
    const where = { modules: scflowCore, key: "scflow:core", type: "scflow:model" };
    const source = await create(dirs, "network", where);
    const run = async (action: string, params: unknown) => {
      const result = await scflow([source, "run", action, JSON.stringify(params), "--modules", scflowCore]);
      expect(result.err).toEqual([]);
      return result.first.result;
    };
    await run("scflow/create_actor_type", { name: "Site", domains: ["physical"] });
    await run("scflow/create_item_type", { name: { fr: "Pièce", en: "Part" }, domain: "physical" });
    await run("scflow/create_actor", { name: "Lyon", type: "Site", description: { fr: "Usine de Lyon", en: "Lyon plant" }, tags: ["main"] });
    await run("scflow/create_actor", { name: "Paris", type: "Site" });
    await run("scflow/create_item", { name: "Bolt", type: "Part" });
    await run("scflow/create_flow", { source: "Lyon", destination: "Paris", item: "Bolt" });

    const first = join(dirs.root, "first");
    const exported = await scflow([source, "export", first, "--modules", scflowCore]);
    expect(exported.code).toBe(0);
    expect(exported.first.skipped).toEqual([]);
    expect(exported.first.files).toEqual(expect.arrayContaining(["actor.csv", "flow.csv", "item.csv"]));
    expect(Object.fromEntries(filesOf(first))["flow.csv"]).toContain("Lyon,Paris,Bolt");

    const target = await create(dirs, "copy", where);
    const imported = await scflow([target, "import", first, "--modules", scflowCore]);
    expect(imported.err).toEqual([]);
    expect(imported.first).toMatchObject({ ok: true, refused: 0 });
    expect(imported.code).toBe(0);

    const second = join(dirs.root, "second");
    await scflow([target, "export", second, "--modules", scflowCore]);
    expect(filesOf(second)).toEqual(filesOf(first));
  });
});
