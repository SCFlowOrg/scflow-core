import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as YAML from "js-yaml";
import { createLogger } from "@scfloworg/core";
import { TESTING_ENGINE, createUpgradeLocator, initDataset, registerPersistentFormat, runCommand, upgradeDataset } from "@scfloworg/core/testing";
import type { PersistenceInterface } from "@scfloworg/core";
import { createJsPersistenceInterface } from "@scfloworg/format-js";
import { registerOpenContext } from "../src/datasets.js";
import type { LineSource, Output } from "../src/io.js";
import { runRepl as runReplOn } from "../src/repl.js";
import { createReplState } from "../src/state.js";

// A dedicated `js` impl instance for this test file, registered once under
// its own format name so dataset state can't bleed across test files —
// mirrors packages/conformance/src/index.ts's `runConformanceSuite`.
registerPersistentFormat(createJsPersistenceInterface("repltest"));

/** Runs the loop on a session that may write, as these tests check the commands themselves. */
const runRepl = (lines: Parameters<typeof runReplOn>[0], out: Parameters<typeof runReplOn>[1], state = createReplState({ engine: TESTING_ENGINE })) => runReplOn(lines, out, state);

let counter = 0;
function newLocator(): string {
  counter += 1;
  return `repltest:repl-${Date.now()}-${counter}`;
}

let sharedFormatCounter = 0;

/**
 * A `js` impl wrapped to count `listInstances(rest, "schema", ...)` calls —
 * the one call `@scfloworg/core`'s `loadResolvers` makes per `Resolvers`
 * load — registered under its own fresh format name so this instrumentation
 * can't pick up calls from any other test. Used below to verify
 * `ReplState.apiSession` actually shares one `Resolvers` load across
 * `DatasetContext`s open against the same locator (`registerOpenContext`,
 * `datasets.ts`), the way `packages/core/tests/apiSession.test.ts` verifies
 * the same thing at the `ApiSession` level directly.
 */
function wrappedJsFormat(): { impl: PersistenceInterface; schemaLoads: () => number } {
  sharedFormatCounter += 1;
  const base = createJsPersistenceInterface(`repltest-shared-${sharedFormatCounter}`);
  let count = 0;
  const impl: PersistenceInterface = {
    ...base,
    async listInstances(rest, schema, propertyRoles) {
      if (schema === "schema") count += 1;
      return base.listInstances(rest, schema, propertyRoles);
    },
  };
  return { impl, schemaLoads: () => count };
}

async function seedTaskDemo(locator: string, name = "tasks-demo"): Promise<void> {
  await initDataset(locator, name);
  const upgradeLocator = await createUpgradeLocator(locator);
  await runCommand(upgradeLocator, {
    create: "schema",
    input: [
      {
        name: "person",
        shared_by_name: null,
        properties: [
          { name: "name", type: "identifier" },
          { name: "email", type: "email" },
        ],
      },
    ],
  });
  await runCommand(upgradeLocator, {
    create: "schema",
    input: [
      {
        name: "task",
        is_root: null,
        properties: [
          { name: "title", type: "string" },
          { name: "status", type: "string", default_value: "open" },
          { name: "assignee", type: "person" },
        ],
      },
    ],
  });
  await upgradeDataset(locator, upgradeLocator);
}

function arrayLineSource(lines: string[]): LineSource {
  let i = 0;
  return {
    async next() {
      return i < lines.length ? lines[i++] : null;
    },
  };
}

function capturingOutput(): Output & { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    lines,
    errors,
    print: (t) => lines.push(t),
    printError: (t) => errors.push(t),
    prompt: () => {},
  };
}

describe("@scfloworg/cli", () => {
  it("opens an existing dataset with open and runs commands against it", async () => {
    const locator = newLocator();
    await seedTaskDemo(locator);

    const out = capturingOutput();
    await runRepl(
      arrayLineSource([
        `open ${locator}`,
        "run",
        "kind: create",
        "schema: person",
        'input: [{name: alice, email: "alice@example.com"}]',
        "",
        "run",
        "kind: create",
        "schema: task",
        "as: t1",
        'input: [{title: "Ship the REPL", assignee: alice}]',
        "",
        "run",
        "kind: query",
        "schema: task",
        'filters: {id: "${t1.after.0.id}"}',
        "",
        "print r.after.0.title",
      ]),
      out,
    );

    expect(out.errors).toEqual([]);
    // "open" confirmation, create person, create task, query, print -> 5 prints ("run" itself is silent)
    expect(out.lines).toHaveLength(5);
    expect(out.lines[1]).toBe("before: 0  after: 1  cascade-deleted: 0  updated-before: 0  updated-after: 0"); // create person
    expect(out.lines[2]).toBe("before: 0  after: 1  cascade-deleted: 0  updated-before: 0  updated-after: 0"); // create task
    expect(out.lines[3]).toBe("before: 0  after: 1  cascade-deleted: 0  updated-before: 0  updated-after: 0"); // the id-filtered query found it
    expect(out.lines[4]).toBe("Ship the REPL"); // print proves it's really the row we just created
  });

  it("keeps the session alive after a command error, and doesn't record it for save", async () => {
    const locator = newLocator();
    await seedTaskDemo(locator);
    const out = capturingOutput();
    await runRepl(
      arrayLineSource([
        `open ${locator}`,
        "run",
        "kind: query",
        "schema: nonexistent",
        "",
        "run",
        "kind: query",
        "schema: task",
        "",
      ]),
      out,
    );
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0]).toContain("unknown_schema");
    expect(out.lines).toHaveLength(2); // "open" confirmation + the second, valid query's result
    expect(out.lines[1]).toBe("before: 0  after: 0  cascade-deleted: 0  updated-before: 0  updated-after: 0");
  });

  it("scopes result variables per dataset name, and every command also sets $r", async () => {
    const locA = newLocator();
    const locB = newLocator();
    await seedTaskDemo(locA, "dbA");
    await seedTaskDemo(locB, "dbB");
    const out = capturingOutput();
    await runRepl(
      arrayLineSource([
        `open ${locA}`,
        `open ${locB}`,
        "run",
        "kind: create",
        "schema: person",
        "as: p1",
        'input: [{name: alice, email: "alice@example.com"}]',
        "",
        "vars",
        "use dbB",
        "vars",
        "datasets",
      ]),
      out,
    );
    expect(out.errors).toEqual([]);
    expect(out.lines).toContain("r");
    expect(out.lines).toContain("p1");
    expect(out.lines.some((l) => l.includes("(no variables yet"))).toBe(true);
    expect(out.lines.some((l) => l.startsWith("* dbB"))).toBe(true);
    expect(out.lines.some((l) => l.startsWith("  dbA"))).toBe(true);
  });

  it("fails new on a locator that's already initialized (use open instead)", async () => {
    const locator = newLocator();
    await seedTaskDemo(locator);
    const out = capturingOutput();
    await runRepl(arrayLineSource([`new ${locator} A`]), out);
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0]).toContain("dataset_already_exists");
  });

  it("open registers the dataset under its own stored name", async () => {
    const locator = newLocator();
    await seedTaskDemo(locator); // seedTaskDemo always names the dataset "tasks-demo"
    const out = capturingOutput();
    await runRepl(
      arrayLineSource([`open ${locator}`, "run", "kind: query", "schema: task", "", "vars"]),
      out,
    );
    expect(out.errors).toEqual([]);
    expect(out.lines[0]).toBe(`opened "tasks-demo" -> ${locator} (current)`);
    expect(out.lines).toContain("r"); // "vars" ran against the auto-named context, proving it's really current
  });

  it("opening a dataset whose name is already in use overwrites the earlier context, with a warning, not an error", async () => {
    // seedTaskDemo always names the dataset "tasks-demo" — two datasets built
    // from it therefore share a name, even though they're at different locators.
    const locator1 = newLocator();
    const locator2 = newLocator();
    await seedTaskDemo(locator1);
    await seedTaskDemo(locator2);
    const out = capturingOutput();
    await runRepl(arrayLineSource([`open ${locator1}`, `open ${locator2}`, "datasets"]), out);
    expect(out.errors).toEqual([]);
    expect(out.lines[0]).toBe(`opened "tasks-demo" -> ${locator1} (current)`);
    expect(out.lines[1]).toBe('warning: "tasks-demo" was already open — overwritten');
    expect(out.lines[2]).toBe(`opened "tasks-demo" -> ${locator2} (current)`);
    expect(out.lines[3]).toBe(`* tasks-demo  ${locator2}`); // only one entry — the second open replaced the first
  });

  it("open reports a clear error when the locator has no dataset to look a name up from", async () => {
    const locator = newLocator(); // never initialized — nothing at this locator to look a name up from
    const out = capturingOutput();
    await runRepl(arrayLineSource([`open ${locator}`]), out);
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0]).toContain("no dataset at");
  });

  it("open reports a usage error when the locator is missing", async () => {
    const out = capturingOutput();
    await runRepl(arrayLineSource(["open"]), out);
    expect(out.errors).toEqual(["usage: open <locator>"]);
  });

  it("supports YAML snippets as a textual splice, distinct from ${...} placeholders", async () => {
    const locator = newLocator();
    await seedTaskDemo(locator);
    const out = capturingOutput();
    await runRepl(
      arrayLineSource([
        `open ${locator}`,
        "run",
        "kind: create",
        "schema: task",
        'input: [{title: "Open one"}, {title: "Also open"}]',
        "",
        "snippet save open_only",
        "filters:",
        "  status: open",
        "",
        "run",
        "kind: query",
        "schema: task",
        "$open_only",
        "",
        "print r.after.0.title",
        "print r.after.1.title",
      ]),
      out,
    );
    expect(out.errors).toEqual([]);
    expect(out.lines).toContain("(saved as $open_only)");
    const queryResult = out.lines[out.lines.length - 3]; // the query's own one-line summary
    expect(queryResult).toBe("before: 0  after: 2  cascade-deleted: 0  updated-before: 0  updated-after: 0");
    expect(out.lines[out.lines.length - 2]).toBe("Open one");
    expect(out.lines[out.lines.length - 1]).toBe("Also open");
  });

  it("accepts a pre-populated ReplState, as cli.ts's --init flow provides", async () => {
    const locator = newLocator();
    await seedTaskDemo(locator);
    const state = createReplState({ engine: TESTING_ENGINE });
    await registerOpenContext(state, "pre", locator);
    expect(state.currentName).toBe("pre");

    const out = capturingOutput();
    await runRepl(arrayLineSource(["run", "kind: query", "schema: task", ""]), out, state);
    expect(out.errors).toEqual([]);
    expect(out.lines).toHaveLength(1); // no "open" confirmation this time — the dataset was already open
  });

  it("two dataset contexts opened against the same locator, in the same ReplState, share one Resolvers load", async () => {
    const { impl, schemaLoads } = wrappedJsFormat();
    registerPersistentFormat(impl);
    const locator = `${impl.name}:shared`;
    await seedTaskDemo(locator);
    const baseline = schemaLoads(); // seeding itself touches "schema" listInstances, against other rests (the upgrade locator) — snapshot after it's done

    const state = createReplState({ engine: TESTING_ENGINE });
    const { ctx: first } = await registerOpenContext(state, "first", locator);
    const { ctx: second } = await registerOpenContext(state, "second", locator);

    // registerOpenContext only opens the ScriptSession — createScriptSession's
    // getResolvers is looked up lazily, inside run() (see script.ts's
    // createScriptSession doc comment), so the Resolvers load itself only
    // happens once each session actually runs a command.
    await first.session.run({ kind: "query", schema: "task" });
    await second.session.run({ kind: "query", schema: "task" });

    expect(schemaLoads() - baseline).toBe(1);
  });

  it("two separate ReplStates (as two separate REPL processes would be) do not share their Resolvers cache", async () => {
    const { impl, schemaLoads } = wrappedJsFormat();
    registerPersistentFormat(impl);
    const locator = `${impl.name}:separate`;
    await seedTaskDemo(locator);
    const baseline = schemaLoads();

    const { ctx: a } = await registerOpenContext(createReplState({ engine: TESTING_ENGINE }), "a", locator);
    const { ctx: b } = await registerOpenContext(createReplState({ engine: TESTING_ENGINE }), "b", locator);

    await a.session.run({ kind: "query", schema: "task" });
    await b.session.run({ kind: "query", schema: "task" });

    expect(schemaLoads() - baseline).toBe(2);
  });

  it("a two-pass runRepl sharing one ReplState — cli.ts's --init flow — carries the dataset context and its result variables from the init pass into the interactive one", async () => {
    const locator = newLocator();
    await seedTaskDemo(locator);

    // The --init pass: opens the dataset and runs one command, exactly as
    // cli.ts does before starting the real interactive loop.
    const state = createReplState({ engine: TESTING_ENGINE });
    const initOut = capturingOutput();
    await runRepl(
      arrayLineSource([`open ${locator}`, "run", "create: task", "as: seeded", 'input: [{title: "from init"}]', ""]),
      initOut,
      state,
    );
    expect(initOut.errors).toEqual([]);

    // The interactive pass: same state, no "open" line — the dataset is
    // already current — and `${seeded...}` (named in the init pass) still
    // resolves, proving both the context and its variables carried over.
    const out = capturingOutput();
    await runRepl(arrayLineSource(["run", "kind: query", "schema: task", 'filters: {title: "${seeded.after.0.title}"}', ""]), out, state);
    expect(out.errors).toEqual([]);
    expect(out.lines).toEqual(["before: 0  after: 1  cascade-deleted: 0  updated-before: 0  updated-after: 0"]);
  });

  it("help mcl prints a short command-language cheat sheet", async () => {
    const locator = newLocator();
    await seedTaskDemo(locator);
    const out = capturingOutput();
    await runRepl(arrayLineSource([`open ${locator}`, "help mcl"]), out);
    expect(out.errors).toEqual([]);
    expect(out.lines.some((l) => l.includes("kind: query"))).toBe(true);
    expect(out.lines.some((l) => l.includes("${r."))).toBe(true);
  });

  it("print/show display a variable's content, copy renames one", async () => {
    const locator = newLocator();
    await seedTaskDemo(locator);
    const out = capturingOutput();
    await runRepl(
      arrayLineSource([
        `open ${locator}`,
        "run",
        "kind: create",
        "schema: task",
        "as: t1",
        'input: [{title: "Forgot the as"}]',
        "",
        "print t1",
        "show r",
        "copy r saved",
        "vars",
        "print saved",
      ]),
      out,
    );
    expect(out.errors).toEqual([]);
    expect(out.lines.some((l) => l.includes("title: Forgot the as"))).toBe(true);
    expect(out.lines).toContain("saved");
    expect(out.lines).toContain("copied r -> saved");
    const printedSaved = out.lines[out.lines.length - 1];
    expect(printedSaved).toContain("title: Forgot the as");
  });

  it("print/show/copy report an unknown variable without crashing the session", async () => {
    const locator = newLocator();
    await seedTaskDemo(locator);
    const out = capturingOutput();
    await runRepl(
      arrayLineSource([`open ${locator}`, "print nope", "copy nope somewhere", "run", "kind: query", "schema: task", ""]),
      out,
    );
    expect(out.errors).toHaveLength(2);
    expect(out.errors[0]).toContain("unknown_reference");
    expect(out.errors[1]).toContain("unknown_reference");
    expect(out.lines).toHaveLength(2); // "open" confirmation + the final query's result
  });

  it("print/copy accept a dot-path into a variable, not just a bare name", async () => {
    const locator = newLocator();
    await seedTaskDemo(locator);
    const out = capturingOutput();
    await runRepl(
      arrayLineSource([
        `open ${locator}`,
        "run",
        "kind: create",
        "schema: task",
        'input: [{title: "Deep dive"}]',
        "",
        "print r.after.0.title",
        "copy r.after.0 created",
        "print created.title",
        "run",
        "kind: query",
        "schema: task",
        'filters: {title: "${created.title}"}',
        "",
        "print r.after.0.title",
      ]),
      out,
    );
    expect(out.errors).toEqual([]);
    expect(out.lines).toHaveLength(7);
    expect(out.lines[2]).toBe("Deep dive"); // print of a scalar path — the bare value, not wrapped in a result shape
    expect(out.lines[3]).toBe("copied r.after.0 -> created");
    expect(out.lines[4]).toBe("Deep dive"); // print created.title, after the copy
    expect(out.lines[5]).toBe("before: 0  after: 1  cascade-deleted: 0  updated-before: 0  updated-after: 0"); // the query, found via ${created.title}
    expect(out.lines[6]).toBe("Deep dive"); // confirms it's really the same row
  });

  it("print accepts * to map a dot-path over every array entry instead of defaulting to entry 0", async () => {
    const locator = newLocator();
    await seedTaskDemo(locator);
    const out = capturingOutput();
    await runRepl(
      arrayLineSource([
        `open ${locator}`,
        "run",
        "kind: create",
        "schema: task",
        'input: [{title: "First"}, {title: "Second"}, {title: "Third"}]',
        "",
        "print r.after.title", // no * — defaults to entry 0, same as always
        "print r.after.*.title", // * — every entry's title, as an array
      ]),
      out,
    );
    expect(out.errors).toEqual([]);
    expect(out.lines[2]).toBe("First");
    expect(YAML.load(out.lines[3])).toEqual(["First", "Second", "Third"]);
  });

  it("defaults an omitted array index to 0 in print, same as a ${...} placeholder", async () => {
    const locator = newLocator();
    await seedTaskDemo(locator);
    const out = capturingOutput();
    await runRepl(
      arrayLineSource([
        `open ${locator}`,
        "run",
        "kind: create",
        "schema: task",
        'input: [{title: "Only one"}]',
        "",
        "print r.after.name", // no index — defaults to .0, but the schema field is "title" not "name"
        "print r.after.title",
        "print r.after.0.title",
      ]),
      out,
    );
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0]).toContain("unknown_reference");
    expect(out.lines).toHaveLength(4); // "open", the create's summary, then the two successful print calls
    expect(out.lines[2]).toBe("Only one"); // r.after.title === r.after.0.title
    expect(out.lines[3]).toBe("Only one");
  });

  it("resolves an unambiguous meta-command abbreviation, and rejects an ambiguous one", async () => {
    const locator = newLocator();
    await seedTaskDemo(locator);
    const out = capturingOutput();
    await runRepl(
      arrayLineSource([
        `o ${locator}`, // open
        "run",
        "kind: create",
        "schema: task",
        "as: t1",
        'input: [{title: "Abbreviated"}]',
        "",
        "p t1.after.0.title", // print
        "s", // ambiguous: save / show / snippet
        "sh t1.after.0.title", // show
        "h", // help
      ]),
      out,
    );
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0]).toBe('"s" is ambiguous — matches save, show, snippet');
    // "o" confirmation, create summary (from "run"), p, sh, then help's full line list
    expect(out.lines[0]).toBe(`opened "tasks-demo" -> ${locator} (current)`);
    expect(out.lines[2]).toBe("Abbreviated"); // p t1.after.0.title
    expect(out.lines[3]).toBe("Abbreviated"); // sh t1.after.0.title
    expect(out.lines.some((l) => l.includes("new <locator> <name>"))).toBe(true); // h -> full help text
  });

  it("resolves 'r' as an unambiguous abbreviation for run", async () => {
    const locator = newLocator();
    await seedTaskDemo(locator);
    const out = capturingOutput();
    await runRepl(arrayLineSource([`open ${locator}`, "r", "kind: query", "schema: task", ""]), out);
    expect(out.errors).toEqual([]);
    expect(out.lines[1]).toBe("before: 0  after: 0  cascade-deleted: 0  updated-before: 0  updated-after: 0");
  });

  it("'u' is ambiguous between upgrade, upload and use (the trade-off for keeping 'r' unambiguous for run)", async () => {
    const locator = newLocator();
    await seedTaskDemo(locator);
    const out = capturingOutput();
    // Just "u" — since it's rejected as ambiguous, there's nothing else to feed it
    // (no dataset context needed, no YAML block awaited).
    await runRepl(arrayLineSource([`open ${locator}`, "u"]), out);
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0]).toBe('"u" is ambiguous — matches upgrade, upload, use');
  });

  it("resolves an abbreviated snippet subcommand normally (only the top-level name is abbreviated)", async () => {
    const locator = newLocator();
    await seedTaskDemo(locator);
    const out = capturingOutput();
    await runRepl(arrayLineSource([`o ${locator}`, "sn save greeting", "hello: world", ""]), out);
    expect(out.errors).toEqual([]);
    expect(out.lines).toContain("(saved as $greeting)");
  });

  it("reports an unknown snippet reference without crashing the session", async () => {
    const locator = newLocator();
    await seedTaskDemo(locator);
    const out = capturingOutput();
    await runRepl(
      arrayLineSource([
        `open ${locator}`,
        "run",
        "kind: query",
        "schema: task",
        "$never_saved",
        "",
        "run",
        "kind: query",
        "schema: task",
        "",
      ]),
      out,
    );
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0]).toContain("unknown snippet");
    expect(out.lines).toHaveLength(2); // "open" confirmation + the second query's result
  });

  it("accepts the create:/query: sugar in place of kind:+schema:", async () => {
    const locator = newLocator();
    await seedTaskDemo(locator);
    const out = capturingOutput();
    await runRepl(
      arrayLineSource([
        `open ${locator}`,
        "run",
        "create: person",
        "as: p1",
        'input: [{name: alice, email: "alice@example.com"}]',
        "",
        "run",
        "query: person",
        "filters: {name: alice}",
        "",
        "print r.after.0.email",
      ]),
      out,
    );
    expect(out.errors).toEqual([]);
    expect(out.lines[1]).toBe("before: 0  after: 1  cascade-deleted: 0  updated-before: 0  updated-after: 0"); // create: sugar
    expect(out.lines[2]).toBe("before: 0  after: 1  cascade-deleted: 0  updated-before: 0  updated-after: 0"); // query: sugar
    expect(out.lines[3]).toBe("alice@example.com");
  });

  it("rejects kind: and a sugar key given together in a typed block", async () => {
    const locator = newLocator();
    await seedTaskDemo(locator);
    const out = capturingOutput();
    await runRepl(arrayLineSource([`open ${locator}`, "run", "kind: query", "create: task", ""]), out);
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0]).toContain("ambiguous_command_kind");
  });

  it("treats a line typed without run as a meta-command, not a YAML block (the new default)", async () => {
    const locator = newLocator();
    await seedTaskDemo(locator);
    const out = capturingOutput();
    await runRepl(arrayLineSource([`open ${locator}`, "kind: query"]), out);
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0]).toContain('unknown command "kind:"');
  });

  it("returns to meta-command mode automatically after run's one block", async () => {
    const locator = newLocator();
    await seedTaskDemo(locator);
    const out = capturingOutput();
    await runRepl(
      arrayLineSource([
        `open ${locator}`,
        "run",
        "kind: query",
        "schema: task",
        "",
        "vars", // no second "run" needed — resolved as a meta-command again
      ]),
      out,
    );
    expect(out.errors).toEqual([]);
    expect(out.lines[1]).toBe("before: 0  after: 0  cascade-deleted: 0  updated-before: 0  updated-after: 0");
    expect(out.lines).toContain("r"); // "vars" ran as a meta-command, proving we're back
  });

  it("print with a trailing file argument writes the YAML dump there instead of printing it", async () => {
    const locator = newLocator();
    await seedTaskDemo(locator);
    const dir = await mkdtemp(join(tmpdir(), "repl-print-file-"));
    const file = join(dir, "captured.yaml");
    const out = capturingOutput();
    await runRepl(
      arrayLineSource([
        `open ${locator}`,
        "run",
        "kind: create",
        "schema: task",
        'input: [{title: "Save me"}]',
        "",
        `print r.after.0 ${file}`,
      ]),
      out,
    );
    expect(out.errors).toEqual([]);
    expect(out.lines[2]).toBe(`saved r.after.0 to ${file}`); // no YAML dump on stdout this time
    const written = await readFile(file, "utf8");
    expect(written).toContain("title: Save me");
  });

  it("round-trips a printed value through a file back into a reusable $snippet", async () => {
    const locator = newLocator();
    await seedTaskDemo(locator);
    const dir = await mkdtemp(join(tmpdir(), "repl-print-file-"));
    const file = join(dir, "filters.yaml");
    const out = capturingOutput();
    await runRepl(
      arrayLineSource([
        `open ${locator}`,
        "run",
        "kind: create",
        "schema: task",
        'input: [{title: "Find me"}]',
        "as: t1",
        "",
        `print t1.after.0.id ${file}`, // write just the id, as a bare scalar, to disk
        "snippet load found_id " + file,
        "run",
        "kind: query",
        "schema: task",
        "filters: {id: $found_id}",
        "",
      ]),
      out,
    );
    expect(out.errors).toEqual([]);
    expect(out.lines).toContain(`loaded as $found_id`);
    // the id-filtered query (via the reloaded snippet) found exactly the one task
    expect(out.lines[out.lines.length - 1]).toBe("before: 0  after: 1  cascade-deleted: 0  updated-before: 0  updated-after: 0");
  });

  it("dump writes a whole-dataset snapshot, upload reads it back into a fresh dataset under the dump's own dataset name", async () => {
    const locator = newLocator();
    await seedTaskDemo(locator); // seedTaskDemo always names the dataset "tasks-demo" — see helper above
    const dir = await mkdtemp(join(tmpdir(), "repl-dump-upload-"));
    const file = join(dir, "snapshot.yaml");
    const uploadLocator = newLocator();
    const out = capturingOutput();
    await runRepl(
      arrayLineSource([
        `open ${locator}`,
        "run",
        "kind: create",
        "schema: task",
        'input: [{title: "Dump me"}]',
        "",
        `dump ${file}`,
        // uploads under the dump's own dataset name, "tasks-demo" — the same
        // name the just-opened context above is already registered under, so
        // this overwrites it (with a warning), and is already current.
        `upload ${uploadLocator} ${file}`,
        "run",
        "kind: query",
        "schema: task",
        "",
        "print r.after.0.title",
      ]),
      out,
    );
    expect(out.errors).toEqual([]);
    expect(out.lines).toContain(`dumped "tasks-demo" -> ${file} (yaml)`);
    expect(out.lines).toContain('warning: "tasks-demo" was already open — overwritten');
    expect(out.lines.some((l) => l.startsWith(`uploaded "tasks-demo" -> ${uploadLocator} from ${file}`))).toBe(true);
    // the uploaded dataset carries its own schemas (task) and data (the row dumped above) — not an empty new dataset
    expect(out.lines[out.lines.length - 2]).toBe("before: 0  after: 1  cascade-deleted: 0  updated-before: 0  updated-after: 0");
    expect(out.lines[out.lines.length - 1]).toBe("Dump me");
  });

  it("dump defaults to yaml, and accepts json explicitly", async () => {
    const locator = newLocator();
    await seedTaskDemo(locator);
    const dir = await mkdtemp(join(tmpdir(), "repl-dump-format-"));
    const yamlFile = join(dir, "snap.yaml");
    const jsonFile = join(dir, "snap.json");
    const out = capturingOutput();
    await runRepl(arrayLineSource([`open ${locator}`, `dump ${yamlFile}`, `dump ${jsonFile} json`]), out);
    expect(out.errors).toEqual([]);
    const yamlText = await readFile(yamlFile, "utf8");
    const jsonText = await readFile(jsonFile, "utf8");
    expect(jsonText.trimStart().startsWith("{")).toBe(true);
    expect(yamlText.trimStart().startsWith("{")).toBe(false);
    expect(JSON.parse(jsonText).dataset).toBeDefined();
  });

  it("dump/upload report an unknown format instead of guessing", async () => {
    const locator = newLocator();
    await seedTaskDemo(locator);
    const dir = await mkdtemp(join(tmpdir(), "repl-dump-badformat-"));
    const file = join(dir, "snap.yaml");
    const out = capturingOutput();
    await runRepl(arrayLineSource([`open ${locator}`, `dump ${file} xml`, `upload ${newLocator()} ${file} xml`]), out);
    expect(out.errors).toHaveLength(2);
    expect(out.errors[0]).toContain('unknown format "xml"');
    expect(out.errors[1]).toContain('unknown format "xml"');
  });

  it("upload refuses to upload into a locator that already has a dataset", async () => {
    const locator = newLocator();
    await seedTaskDemo(locator);
    const dir = await mkdtemp(join(tmpdir(), "repl-upload-conflict-"));
    const file = join(dir, "snap.yaml");
    const out = capturingOutput();
    await runRepl(arrayLineSource([`open ${locator}`, `dump ${file}`, `upload ${locator} ${file}`]), out);
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0]).toContain("dataset_already_exists");
  });

  it("upload overwrites a same-named context already open in this session — no error, just a warning", async () => {
    // seedTaskDemo always names the dataset "tasks-demo" — the uploaded
    // dump carries that same name, so it collides with the still-open
    // locator1 context by name alone.
    const locator1 = newLocator();
    await seedTaskDemo(locator1);
    const dir = await mkdtemp(join(tmpdir(), "repl-upload-namecollide-"));
    const file = join(dir, "snap.yaml");
    const uploadLocator = newLocator();
    const out = capturingOutput();
    await runRepl(
      arrayLineSource([
        `open ${locator1}`, // registers "tasks-demo" -> locator1
        `dump ${file}`, // dumps locator1 — still named "tasks-demo" internally
        `upload ${uploadLocator} ${file}`, // also named "tasks-demo" — overwrites the registry entry, with a warning
        `open ${locator1}`, // locator1's own dataset is untouched by the overwrite above — reopening it recovers it
      ]),
      out,
    );
    expect(out.errors).toEqual([]);
    expect(out.lines.filter((l) => l.startsWith("warning:"))).toHaveLength(2); // upload's overwrite, then reopening locator1 overwrites it back
    expect(out.lines[0]).toBe(`opened "tasks-demo" -> ${locator1} (current)`);
    expect(out.lines.some((l) => l.startsWith(`uploaded "tasks-demo" -> ${uploadLocator} from ${file}`))).toBe(true);
    expect(out.lines[out.lines.length - 1]).toBe(`opened "tasks-demo" -> ${locator1} (current)`);
  });

  it("upload reports a usage error when args are missing", async () => {
    const out = capturingOutput();
    await runRepl(arrayLineSource(["upload onlylocator"]), out);
    expect(out.errors).toEqual(["usage: upload <locator> <file> [json|yaml]"]);
  });

  it("dump requires a current dataset", async () => {
    const out = capturingOutput();
    await runRepl(arrayLineSource(["dump out.yaml"]), out);
    expect(out.errors).toEqual(["no current dataset — open one with new or open, then use"]);
  });

  it("takes a quoted argument holding spaces, and the whole line as open's locator", async () => {
    const { tokenizeMetaLine } = await import("../src/meta.js");
    expect(tokenizeMetaLine('new "I:/My Vault/00-VAULT_MODEL" vault_model')).toEqual([
      "new",
      "I:/My Vault/00-VAULT_MODEL",
      "vault_model",
    ]);
    expect(tokenizeMetaLine("  use   tasks-demo (upgrade)  ")).toEqual(["use", "tasks-demo", "(upgrade)"]);
    expect(tokenizeMetaLine("")).toEqual([]);

    const locator = newLocator();
    await seedTaskDemo(locator);
    const out = capturingOutput();
    await runRepl(arrayLineSource([`open ${locator}`]), out);
    expect(out.errors).toEqual([]);
    expect(out.lines[0]).toBe(`opened "tasks-demo" -> ${locator} (current)`);
  });

  it("upgrade/changes/check/commit add a schema and leave it usable in the source context straight away", async () => {
    const locator = newLocator();
    await seedTaskDemo(locator);
    const out = capturingOutput();
    await runRepl(
      arrayLineSource([
        `open ${locator}`,
        "upgrade",
        "run",
        "create: schema",
        'input: [{name: label, shared_by_name: null, properties: [{name: name, type: identifier}]}]',
        "",
        "changes",
        "check",
        "commit",
        // The point of the invalidate call in commitUpgradeContext: this
        // context was opened before the schema existed, and its Resolvers
        // are cached for the process's lifetime.
        "run",
        "create: label",
        'input: [{name: urgent}]',
        "",
      ]),
      out,
    );
    expect(out.errors).toEqual([]);
    expect(out.lines).toContain("after:           label");
    expect(out.lines).toContain("autoUpdate: 0  modifiedSchema: 0  lostSchema: 0");
    expect(out.lines).toContain("current dataset: tasks-demo");
    expect(out.lines.at(-1)).toBe("before: 0  after: 1  cascade-deleted: 0  updated-before: 0  updated-after: 0");
  });

  it("discard throws the recorded model changes away", async () => {
    const locator = newLocator();
    await seedTaskDemo(locator);
    const out = capturingOutput();
    await runRepl(
      arrayLineSource([
        `open ${locator}`,
        "upgrade",
        "run",
        "create: schema",
        'input: [{name: label, shared_by_name: null, properties: [{name: name, type: identifier}]}]',
        "",
        "discard",
        "run",
        "create: label",
        'input: [{name: urgent}]',
        "",
      ]),
      out,
    );
    expect(out.lines).toContain("current dataset: tasks-demo");
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0]).toContain("unknown_schema");
  });

  it("changes/check/commit/discard refuse an ordinary dataset context", async () => {
    const locator = newLocator();
    await seedTaskDemo(locator);
    const out = capturingOutput();
    await runRepl(arrayLineSource([`open ${locator}`, "changes", "check", "commit", "discard"]), out);
    expect(out.errors).toEqual(Array(4).fill('"tasks-demo" is an ordinary dataset — start a model change with upgrade first'));
  });

  it("open recognizes an upgrade locator created outside this session", async () => {
    const locator = newLocator();
    await seedTaskDemo(locator);
    const upgradeLocator = await createUpgradeLocator(locator);
    const out = capturingOutput();
    await runRepl(
      arrayLineSource([`open ${locator}`, `open ${upgradeLocator}`, "use tasks-demo (upgrade)", "datasets", "discard"]),
      out,
    );
    expect(out.errors).toEqual([]);
    expect(out.lines.some((l) => l.includes(`(upgrade of ${locator})`))).toBe(true);
  });

  it("log-level changes state.logger.level immediately, without printing anything to the log itself", async () => {
    const state = createReplState({ engine: TESTING_ENGINE, logger: createLogger(() => {}) }); // an isolated logger — not the shared noopLogger singleton, so this test's mutation can't leak into another
    expect(state.logger.level).toBe("info"); // createLogger's own default
    const out = capturingOutput();
    await runRepl(arrayLineSource(["log-level debug"]), out, state);
    expect(out.errors).toEqual([]);
    expect(out.lines).toEqual(["log level: debug"]);
    expect(state.logger.level).toBe("debug");
  });

  it("log-level reports a usage error on a missing or unknown level, and leaves the level untouched", async () => {
    const state = createReplState({ engine: TESTING_ENGINE, logger: createLogger(() => {}) });
    const out = capturingOutput();
    await runRepl(arrayLineSource(["log-level", "log-level verbose"]), out, state);
    expect(out.errors).toEqual(["usage: log-level <debug|info|warn|error>", "usage: log-level <debug|info|warn|error>"]);
    expect(out.lines).toEqual([]);
    expect(state.logger.level).toBe("info");
  });
});
