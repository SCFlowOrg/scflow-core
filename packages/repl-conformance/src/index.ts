import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import * as YAML from "js-yaml";
import { describe, expect, it } from "vitest";
import { TESTING_ENGINE, createUpgradeLocator, initDataset, registerPersistentFormat, runCommand, upgradeDataset } from "@scfloworg/core/testing";
import type { PersistenceInterface, TransientValue } from "@scfloworg/core";
import { createReplState, currentContext, registerOpenContext, runCommandBlock } from "@scfloworg/repl";
import type { Output } from "@scfloworg/repl";

/**
 * A REPL-level conformance suite.
 *
 * Each fixture under `fixtures/` is one scenario: an optional seed (raw
 * `scalar_type`/`schema` description lists, applied before any commands run
 * — see `SeedFile`/`applySeed` below), an ordered list of commands given as
 * raw YAML *text* (exactly what you'd type after `run`), and optional
 * expectations checked against the session's named results afterward. See
 * README.md for the fixture shape and how to add one.
 */

/**
 * A fixture's `seed:` — the same shape a `create: scalar_type`/`create:
 * schema` command's `input` already takes. It is applied with
 * `createUpgradeLocator`, `runCommand` and `upgradeDataset` of
 * `@scfloworg/core`, and is local to this package's fixture format.
 */
export interface SeedFile {
  scalar_types: TransientValue[];
  schemas: TransientValue[];
}

/**
 * Applies `seed` to `locator` — scalar types first, then schemas, each in
 * file order — through a single upgrade locator, since a freshly-initialized
 * dataset has no data yet and every seeded change is trivially compatible.
 */
async function applySeed(locator: string, seed: SeedFile): Promise<void> {
  if (seed.scalar_types.length === 0 && seed.schemas.length === 0) return; // nothing to do — skip the no-op upgrade round-trip
  const upgradeLocator = await createUpgradeLocator(locator);
  for (const scalarType of seed.scalar_types) {
    await runCommand(upgradeLocator, { create: "scalar_type", input: [scalarType] });
  }
  for (const schema of seed.schemas) {
    await runCommand(upgradeLocator, { create: "schema", input: [schema] });
  }
  await upgradeDataset(locator, upgradeLocator);
}

export interface ReplFixtureCommand {
  /** Names this command's result within the fixture — the command language's own `as`. */
  as?: string;
  /** Raw YAML text, exactly as typed at the `run` prompt (may be multi-line/block-style). */
  run: string;
  /**
   * If set, this command must fail, with an error message containing this
   * substring (usually an error code, e.g. "unknown_command_property"). A
   * command without `expectError` must succeed — an unexpected failure
   * fails the fixture with the error's own message.
   */
  expectError?: string;
}

export interface ReplFixtureExpectation {
  /**
   * Dot-path into the session's named results, e.g. `found.after.0.title`
   * — the same grammar `${...}` placeholders and `print`/`show` use, minus
   * the `*` map-over-array form (a fixture asserts one concrete value at a
   * time). `r` is always the last command's implicit result, the same as
   * in a live REPL session.
   */
  path: string;
  /** Deep-equality check against the resolved value. */
  equals?: unknown;
  /** Checked against the resolved value's `.length` (arrays or strings). */
  length?: number;
}

export interface ReplFixture {
  name: string;
  /**
   * The fixture file's directory, relative to `fixtures/`, with `/` as the
   * separator regardless of platform — e.g. a file at `fixtures/sequence/
   * order-next-previous.yaml` has `group: "sequence"`. Undefined for a
   * fixture directly under `fixtures/`. Populated by `loadFixtures`, not
   * read from the fixture file itself; see README.md's "Fixtures" section.
   */
  group?: string;
  seed?: SeedFile;
  commands: ReplFixtureCommand[];
  expect?: ReplFixtureExpectation[];
}

const FIXTURES_DIR = fileURLToPath(new URL("../fixtures", import.meta.url));

/** Recursively collects every `*.yaml` file under `dir`, as paths relative to `FIXTURES_DIR`. */
function collectFixturePaths(dir: string): string[] {
  const paths: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      paths.push(...collectFixturePaths(full));
    } else if (entry.isFile() && entry.name.endsWith(".yaml")) {
      paths.push(relative(FIXTURES_DIR, full));
    }
  }
  return paths;
}

/**
 * A fixture's `seed:` is `SeedFile`-shaped, but hand-authored YAML naturally
 * omits whichever of `scalar_types`/`schemas` a scenario doesn't need (both
 * fixtures shipped today only set `schemas`) — `applySeed` assumes both
 * arrays are always present, so this defaults a missing one to `[]`.
 */
function normalizeSeed(raw: unknown): SeedFile | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error('fixture "seed" must be a mapping with "scalar_types" and/or "schemas"');
  }
  const obj = raw as Partial<SeedFile>;
  return {
    scalar_types: obj.scalar_types ?? [],
    schemas: obj.schemas ?? [],
  };
}

function loadFixtures(): ReplFixture[] {
  return collectFixturePaths(FIXTURES_DIR)
    .sort()
    .map((relPath) => {
      const raw = YAML.load(readFileSync(join(FIXTURES_DIR, relPath), "utf8")) as ReplFixture;
      const dir = dirname(relPath);
      const group = dir === "." ? undefined : dir.split(sep).join("/");
      return { ...raw, seed: normalizeSeed(raw.seed), group };
    });
}

/** Walks a dot-path over the plain object/array shape a CommandResult (or an array within one) already is. */
function resolvePath(root: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((cur, segment) => {
    if (cur === null || typeof cur !== "object") return undefined;
    const key: string | number = Array.isArray(cur) ? Number(segment) : segment;
    return (cur as Record<string | number, unknown>)[key];
  }, root);
}

function capturingErrors(): Output & { errors: string[] } {
  const errors: string[] = [];
  return {
    errors,
    print: () => {},
    printError: (t) => errors.push(t),
    prompt: () => {},
  };
}

let counter = 0;

/** Registers one fixture's `it`, running its seed/commands/expectations against `formatName`'s dataset. */
function registerFixtureTest(fixture: ReplFixture, formatName: string): void {
  it(fixture.name, async () => {
    counter += 1;
    const locator = `${formatName}:repl-conformance-${Date.now()}-${counter}`;

    // initDataset, then applySeed, *then* open the ScriptSession — seeding
    // after the session exists would leave a freshly-added schema invisible
    // to it (createScriptSession snapshots resolvers once, at open time; see
    // datasets.ts's registerOpenContext).
    await initDataset(locator, "fixture");
    if (fixture.seed) await applySeed(locator, fixture.seed);
    const state = createReplState({ engine: TESTING_ENGINE });
    await registerOpenContext(state, "fixture", locator);

    const out = capturingErrors();
    for (const command of fixture.commands) {
      const blockText = command.as ? `as: ${command.as}\n${command.run}` : command.run;
      const before = out.errors.length;
      await runCommandBlock(state, blockText, out);
      const newErrors = out.errors.slice(before);
      if (command.expectError) {
        expect(newErrors, `expected an error containing "${command.expectError}" running:\n${command.run}`).toHaveLength(1);
        expect(newErrors[0]).toContain(command.expectError);
      } else {
        expect(newErrors, `unexpected error running:\n${command.run}`).toEqual([]);
      }
    }

    const variables = currentContext(state)?.session.variables ?? {};
    for (const exp of fixture.expect ?? []) {
      const actual = resolvePath(variables, exp.path);
      if ("equals" in exp) expect(actual, exp.path).toEqual(exp.equals);
      if (exp.length !== undefined) expect(actual, `${exp.path}.length`).toHaveProperty("length", exp.length);
    }
  });
}

/**
 * Registers `impl` and runs every fixture in `fixtures/` against it, the
 * way `@scfloworg/conformance`'s `runConformanceSuite` does for engine-level
 * scenarios — call this once from a format package's own `*.test.ts` file
 * (see `packages/format-js/tests/repl-conformance.test.ts`).
 *
 * `formatName` is both the `describe` label and the locator prefix
 * `registerPersistentFormat`/`initDataset` use — give it a value unique to
 * this test file/process, not necessarily the format's own name (e.g. not
 * bare `"js"` if something else in the same suite already registers that).
 * Two registrations of the same name in one process silently repoint the
 * second one's dataset state onto the first's — see
 * `packages/repl/tests/repl.test.ts`'s own `"repltest"` for the same
 * reasoning.
 */
export function runReplConformanceSuite(impl: PersistenceInterface, formatName: string): void {
  registerPersistentFormat(impl);

  describe(`REPL conformance — ${formatName}`, () => {
    // Fixtures directly under fixtures/ run as plain `it`s, same as before
    // folders existed. A fixture under a subfolder (its `group`, e.g.
    // "sequence" for fixtures/sequence/*.yaml) is nested under its own
    // `describe(group, ...)` instead, so a runner (`vitest -t sequence`, an
    // IDE's "run this describe block") can target just that folder. Groups
    // are keyed in the order their first fixture is encountered — stable
    // because loadFixtures() already returns fixtures sorted by path.
    const groups = new Map<string, ReplFixture[]>();
    for (const fixture of loadFixtures()) {
      if (fixture.group === undefined) {
        registerFixtureTest(fixture, formatName);
        continue;
      }
      const group = groups.get(fixture.group) ?? [];
      group.push(fixture);
      groups.set(fixture.group, group);
    }
    for (const [group, fixtures] of groups) {
      describe(group, () => {
        for (const fixture of fixtures) registerFixtureTest(fixture, formatName);
      });
    }
  });
}
