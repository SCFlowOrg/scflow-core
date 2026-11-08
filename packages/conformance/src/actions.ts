import { describe, expect, it } from "vitest";

/**
 * The cases of the action contract that need no dataset: the check of
 * parameters with the resolution of `ref`, the registry, the run log, the
 * batches made only of calls and the export to AI tools. They follow the
 * Action section of `packages/core/docs/spec/meta-model.md`, the Batches of its
 * `model-command-language.md` and the Action Package section of its
 * `typescript-reference-implementation.md`.
 *
 * An implementation of the action package proves it follows them by calling
 * `runActionConformanceSuite(impl)` from its own test file, as
 * `packages/actions/tests/conformance.test.ts` does. The types below are the
 * shape the suite uses, so this package does not depend on the one it checks.
 */

/** The matches of a `ref` value, as the engine gives them. */
export interface ConformanceRefMatches {
  readonly id: string | null;
  readonly names: readonly string[];
}

/** The host of a run, as the suite gives it. */
export interface ConformanceRunHost {
  context?(trace: ConformanceRunTrace): unknown;
  resolveRef?(
    schema: string,
    value: string,
  ): ConformanceRefMatches | Promise<ConformanceRefMatches>;
  onEntry?(entry: unknown): void;
}

/** The trace a body records its commands and calls through. */
export interface ConformanceRunTrace {
  readonly action: string;
  command(command: unknown, result: unknown): void;
  call(id: string, params?: unknown): Promise<unknown>;
}

/** An action as the suite registers it. */
export interface ConformanceAction {
  readonly id: string;
  readonly title?: string;
  readonly description?: string;
  readonly kind?: "read" | "action";
  readonly destructive?: boolean;
  readonly exposure?: "visible" | "hidden";
  readonly parameters?: Record<string, unknown> | string;
  readonly writes?: readonly string[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  run(params: any, context: any): unknown;
}

/** The registry of actions, as the suite uses it. */
export interface ConformanceRegistry {
  register(action: ConformanceAction): void;
  get(id: string): ConformanceAction | undefined;
  list(): readonly ConformanceAction[];
  run(
    id: string,
    params?: unknown,
    host?: ConformanceRunHost,
  ): Promise<{ result: unknown; entry: unknown }>;
}

/** What an implementation of the action package gives the suite. */
export interface ActionImplementation {
  createRegistry(): ConformanceRegistry;
  runBatch(
    registry: ConformanceRegistry,
    batch: unknown,
    host?: ConformanceRunHost,
  ): Promise<{ result: unknown; entries: readonly unknown[] }>;
  toAiTools(actions: Iterable<ConformanceAction>): readonly unknown[];
  canonicalJson(value: unknown): string;
}

async function refusal(promise: Promise<unknown>): Promise<{ code?: string }> {
  try {
    await promise;
  } catch (error) {
    return error as { code?: string };
  }
  throw new Error("expected a refusal");
}

function refusalOf(run: () => unknown): { code?: string } {
  try {
    run();
  } catch (error) {
    return error as { code?: string };
  }
  throw new Error("expected a refusal");
}

export function runActionConformanceSuite(impl: ActionImplementation): void {
  /** An action that returns its parameters, and counts its runs. */
  function echo(
    id: string,
    parameters?: Record<string, unknown>,
    extra: Partial<ConformanceAction> = {},
  ) {
    const runs: unknown[] = [];
    const action: ConformanceAction = {
      id,
      title: id,
      description: `echoes ${id}`,
      parameters,
      ...extra,
      run(params: unknown) {
        runs.push(params);
        return params;
      },
    };
    return { action, runs };
  }

  /** A resolver over a list of instances of `actor`. */
  function actors(
    instances: readonly { key: string; id: string; display_name: Record<string, string> }[],
  ) {
    return (schema: string, value: string): ConformanceRefMatches => {
      expect(schema).toBe("actor");
      const byId = instances.find((i) => i.id === value);
      return {
        id: byId ? byId.key : null,
        names: instances
          .filter((i) => Object.values(i.display_name).includes(value))
          .map((i) => i.key),
      };
    };
  }

  describe("actions: parameters", () => {
    const parameters = {
      type: "object",
      properties: {
        name: { type: "string" },
        count: { type: "integer", default: 1 },
        note: { type: ["string", "null"] },
      },
      required: ["name"],
      additionalProperties: false,
    };

    it("runs the body with parameters that fit the JSON Schema, with its defaults", async () => {
      const registry = impl.createRegistry();
      const { action, runs } = echo("demo/make", parameters);
      registry.register(action);
      const { result } = await registry.run("demo/make", { name: "a", note: null });
      expect(result).toEqual({ name: "a", count: 1, note: null });
      expect(runs).toHaveLength(1);
    });

    it("refuses parameters that break the JSON Schema with invalid_parameters, before the body runs", async () => {
      const registry = impl.createRegistry();
      const { action, runs } = echo("demo/make", parameters);
      registry.register(action);
      for (const bad of [
        {},
        { name: 1 },
        { name: "a", count: 1.5 },
        { name: "a", other: true },
        null,
        "a",
      ]) {
        expect((await refusal(registry.run("demo/make", bad))).code).toBe("invalid_parameters");
      }
      expect(runs).toHaveLength(0);
    });

    it("reads parameters given as JSON text", async () => {
      const registry = impl.createRegistry();
      const { action } = echo(
        "demo/make",
        JSON.stringify(parameters) as unknown as Record<string, unknown>,
      );
      registry.register(action);
      expect((await registry.run("demo/make", { name: "a" })).result).toEqual({
        name: "a",
        count: 1,
      });
      expect((await refusal(registry.run("demo/make", {}))).code).toBe("invalid_parameters");
    });

    it("takes no parameters as an empty object when none are declared", async () => {
      const registry = impl.createRegistry();
      const { action } = echo("demo/ping");
      registry.register(action);
      expect((await registry.run("demo/ping")).result).toEqual({});
    });

    it("does not change the parameters the caller gave", async () => {
      const registry = impl.createRegistry();
      registry.register(echo("demo/make", parameters).action);
      const given = { name: "a" };
      await registry.run("demo/make", given);
      expect(given).toEqual({ name: "a" });
    });
  });

  describe("actions: ref", () => {
    const parameters = {
      type: "object",
      properties: {
        actor: { type: "string", ref: "actor" },
        others: { type: "array", items: { type: "string", ref: "actor" } },
      },
      required: ["actor"],
    };
    const instances: { key: string; id: string; display_name: Record<string, string> }[] = [
      { key: "k1", id: "a1", display_name: { en: "Plant", fr: "Usine" } },
      { key: "k2", id: "a2", display_name: { en: "a1" } },
      { key: "k3", id: "a3", display_name: { en: "Store" } },
      { key: "k4", id: "a4", display_name: { en: "Store" } },
    ];

    it("gives the body the key of the instance named by its id or by its display_name in any language", async () => {
      const registry = impl.createRegistry();
      registry.register(echo("demo/use", parameters).action);
      const host = { resolveRef: actors(instances) };
      expect((await registry.run("demo/use", { actor: "a1" }, host)).result).toEqual({
        actor: "k1",
      });
      expect(
        (await registry.run("demo/use", { actor: "Usine", others: ["Plant", "a3"] }, host)).result,
      ).toEqual({
        actor: "k1",
        others: ["k1", "k3"],
      });
    });

    it("lets an id win over a name that equals it", async () => {
      const registry = impl.createRegistry();
      registry.register(echo("demo/use", parameters).action);
      expect(
        (await registry.run("demo/use", { actor: "a1" }, { resolveRef: actors(instances) })).result,
      ).toEqual({
        actor: "k1",
      });
    });

    it("refuses a value that matches no instance or several with invalid_parameters", async () => {
      const registry = impl.createRegistry();
      const { action, runs } = echo("demo/use", parameters);
      registry.register(action);
      const host = { resolveRef: actors(instances) };
      expect((await refusal(registry.run("demo/use", { actor: "nobody" }, host))).code).toBe(
        "invalid_parameters",
      );
      expect((await refusal(registry.run("demo/use", { actor: "Store" }, host))).code).toBe(
        "invalid_parameters",
      );
      expect(
        (await refusal(registry.run("demo/use", { actor: "a1", others: ["x"] }, host))).code,
      ).toBe("invalid_parameters");
      expect(runs).toHaveLength(0);
    });
  });

  describe("actions: registry", () => {
    it("refuses an id taken by another action with duplicate_name", () => {
      const registry = impl.createRegistry();
      registry.register(echo("demo/a").action);
      expect(refusalOf(() => registry.register(echo("demo/a").action)).code).toBe("duplicate_name");
    });

    it("refuses an id that is not a namespace, a slash and a name with constraint_violation", () => {
      const registry = impl.createRegistry();
      for (const id of ["a", "demo/", "/a", "demo/a/b", "de-mo/a", "1demo/a"]) {
        expect(refusalOf(() => registry.register(echo(id).action)).code).toBe(
          "constraint_violation",
        );
      }
    });

    it("refuses parameters that are not a valid JSON Schema object with constraint_violation", () => {
      const registry = impl.createRegistry();
      for (const parameters of [
        { type: "string" },
        { type: "object", properties: 3 },
        { type: "object", unknownKeyword: 1 },
      ]) {
        expect(refusalOf(() => registry.register(echo("demo/a", parameters).action)).code).toBe(
          "constraint_violation",
        );
      }
    });

    it("refuses an id that names no action with unknown_action", async () => {
      const registry = impl.createRegistry();
      expect((await refusal(registry.run("demo/none", {}))).code).toBe("unknown_action");
    });

    it("lists the actions in the order they were registered", () => {
      const registry = impl.createRegistry();
      registry.register(echo("demo/b").action);
      registry.register(echo("demo/a").action);
      expect(registry.list().map((a) => a.id)).toEqual(["demo/b", "demo/a"]);
      expect(registry.get("demo/a")?.id).toBe("demo/a");
      expect(registry.get("demo/c")).toBeUndefined();
    });
  });

  describe("actions: run log", () => {
    it("writes JSON in canonical form: keys sorted, no white space", () => {
      expect(impl.canonicalJson({ b: 1, a: { d: [1, { f: null, e: "x" }], c: true } })).toBe(
        '{"a":{"c":true,"d":[1,{"e":"x","f":null}]},"b":1}',
      );
    });

    it("records one entry per call, a nested call as a step, and the commands as the body emitted them", async () => {
      const registry = impl.createRegistry();
      registry.register({
        id: "demo/inner",
        parameters: { type: "object", properties: { n: { type: "integer" } } },
        run(params: { n: number }, trace: ConformanceRunTrace) {
          trace.command({ query: "thing" }, { after: [] });
          return params.n * 2;
        },
      });
      registry.register({
        id: "demo/outer",
        parameters: { type: "object", properties: { actor: { type: "string", ref: "actor" } } },
        async run(params: { actor: string }, trace: ConformanceRunTrace) {
          trace.command(
            { create: "thing", input: { at: "${now()}", actor: params.actor } },
            { after: [{ id: "t1" }] },
          );
          const doubled = await trace.call("demo/inner", { n: 2 });
          return { doubled };
        },
      });
      const entries: unknown[] = [];
      const host = {
        resolveRef: actors([{ key: "k1", id: "a1", display_name: { en: "Plant" } }]),
        onEntry: (entry: unknown) => entries.push(entry),
      };
      const { result, entry } = await registry.run("demo/outer", { actor: "Plant" }, host);
      expect(result).toEqual({ doubled: 4 });
      expect(entries).toEqual([entry]);
      expect(entry).toEqual({
        action: "demo/outer",
        parameters: '{"actor":"k1"}',
        steps: [
          {
            command: { create: "thing", input: { at: "${now()}", actor: "k1" } },
            result: '{"after":[{"id":"t1"}]}',
          },
          {
            call: {
              action: "demo/inner",
              parameters: '{"n":2}',
              steps: [{ command: { query: "thing" }, result: '{"after":[]}' }],
              outcome: "done",
              result: "4",
            },
          },
        ],
        outcome: "done",
        result: '{"doubled":4}',
      });
    });

    it("records a refused call with the code of its exception, its parameters included when they are refused", async () => {
      const registry = impl.createRegistry();
      registry.register({
        id: "demo/fail",
        parameters: { type: "object", properties: { n: { type: "integer" } } },
        run() {
          throw Object.assign(new Error("no"), { code: "procedure_failed" });
        },
      });
      const entries: unknown[] = [];
      const onEntry = (entry: unknown) => entries.push(entry);
      expect((await refusal(registry.run("demo/fail", { n: 1 }, { onEntry }))).code).toBe(
        "procedure_failed",
      );
      expect((await refusal(registry.run("demo/fail", { n: "x" }, { onEntry }))).code).toBe(
        "invalid_parameters",
      );
      expect(entries).toEqual([
        {
          action: "demo/fail",
          parameters: '{"n":1}',
          steps: [],
          outcome: "refused",
          error: "procedure_failed",
        },
        {
          action: "demo/fail",
          parameters: '{"n":"x"}',
          steps: [],
          outcome: "refused",
          error: "invalid_parameters",
        },
      ]);
    });

    it("leaves out the result of an action that returns none", async () => {
      const registry = impl.createRegistry();
      registry.register({ id: "demo/void", run() {} });
      expect((await registry.run("demo/void")).entry).toEqual({
        action: "demo/void",
        parameters: "{}",
        steps: [],
        outcome: "done",
      });
    });
  });

  describe("actions: batches", () => {
    function setup() {
      const registry = impl.createRegistry();
      registry.register({
        id: "demo/create_actor",
        parameters: {
          type: "object",
          properties: { display_name: { type: "string" } },
          required: ["display_name"],
        },
        run: (params: { display_name: string }) => ({
          id: `id-${params.display_name}`,
          display_name: params.display_name,
        }),
      });
      registry.register({
        id: "demo/list",
        parameters: { type: "object" },
        run: () => ({ after: [{ id: "x1" }, { id: "x2" }] }),
      });
      registry.register(echo("demo/echo", { type: "object" }).action);
      return registry;
    }

    it("runs its calls in order, chaining named results through ${name.path}", async () => {
      const registry = setup();
      const { result, entries } = await impl.runBatch(registry, {
        commands: [
          { call: "demo/create_actor", with: { display_name: "Plant" }, as: "plant" },
          { call: "demo/list", as: "list" },
          {
            call: "demo/echo",
            with: {
              id: "${plant.id}",
              label: "actor ${plant.display_name}",
              first: "${list.after.id}",
              second: "${list.after.1.id}",
              all: "${list.after.*.id}",
              at: "${now()}",
            },
          },
        ],
      });
      expect(result).toEqual({
        id: "id-Plant",
        label: "actor Plant",
        first: "x1",
        second: "x2",
        all: ["x1", "x2"],
        at: "${now()}",
      });
      expect(entries.map((e) => (e as { action: string }).action)).toEqual([
        "demo/create_actor",
        "demo/list",
        "demo/echo",
      ]);
    });

    it("gives its result placeholder, or the result of its last call", async () => {
      const registry = setup();
      const { result } = await impl.runBatch(registry, {
        commands: [
          { call: "demo/create_actor", with: { display_name: "A" }, as: "a" },
          { call: "demo/create_actor", with: { display_name: "B" } },
        ],
        result: "${a.id}",
      });
      expect(result).toBe("id-A");
    });

    it("refuses a reference to a name not set yet with unknown_reference", async () => {
      const registry = setup();
      const error = await refusal(
        impl.runBatch(registry, {
          commands: [
            { call: "demo/echo", with: { id: "${later.id}" } },
            { call: "demo/create_actor", with: { display_name: "A" }, as: "later" },
          ],
        }),
      );
      expect(error.code).toBe("unknown_reference");
    });

    it("refuses a step that is not a call with only with and as with invalid_script_step, before any call", async () => {
      for (const step of [
        { create: "actor", input: {} },
        { call: "demo/echo", when: { "params.x": { exists: true } } },
        { each: "${a.after}", do: [] },
        { fail: "no" },
        { call: "demo/echo", as: "not an identifier" },
        {},
      ]) {
        const registry = setup();
        const entries: unknown[] = [];
        const error = await refusal(
          impl.runBatch(
            registry,
            { commands: [{ call: "demo/echo" }, step] },
            { onEntry: (e) => entries.push(e) },
          ),
        );
        expect(error.code).toBe("invalid_script_step");
        expect(entries).toHaveLength(0);
      }
    });

    it("refuses a batch with parameters with invalid_script_step", async () => {
      const error = await refusal(
        impl.runBatch(setup(), { parameters: { type: "object" }, commands: [] }),
      );
      expect(error.code).toBe("invalid_script_step");
    });

    it("stops at a refused call and gives its exception", async () => {
      const registry = setup();
      const entries: unknown[] = [];
      const error = await refusal(
        impl.runBatch(
          registry,
          {
            commands: [{ call: "demo/create_actor", with: {} }, { call: "demo/echo" }],
          },
          { onEntry: (e) => entries.push(e) },
        ),
      );
      expect(error.code).toBe("invalid_parameters");
      expect(entries).toHaveLength(1);
      expect(
        (await refusal(impl.runBatch(registry, { commands: [{ call: "demo/none" }] }))).code,
      ).toBe("unknown_action");
    });
  });

  describe("actions: export to AI tools", () => {
    it("maps each visible action to a tool, with its hints, and leaves hidden actions out", () => {
      const parameters = {
        type: "object",
        properties: { id: { type: "string", ref: "actor" } },
        required: ["id"],
      };
      const tools = impl.toAiTools([
        {
          id: "demo/get_actor",
          title: "Get",
          description: "Gets an actor",
          kind: "read",
          parameters,
          run: () => null,
        },
        {
          id: "demo/delete_actor",
          title: "Delete",
          description: "Deletes",
          destructive: true,
          parameters,
          run: () => null,
        },
        { id: "demo/internal", description: "Hidden", exposure: "hidden", run: () => null },
        { id: "demo/touch", description: "Touches", run: () => null },
      ]);
      expect(tools).toEqual([
        {
          name: "demo-get_actor",
          title: "Get",
          description: "Gets an actor",
          inputSchema: parameters,
          annotations: { title: "Get", readOnlyHint: true, destructiveHint: false },
        },
        {
          name: "demo-delete_actor",
          title: "Delete",
          description: "Deletes",
          inputSchema: parameters,
          annotations: { title: "Delete", readOnlyHint: false, destructiveHint: true },
        },
        {
          name: "demo-touch",
          description: "Touches",
          inputSchema: { type: "object", properties: {} },
          annotations: { readOnlyHint: false, destructiveHint: false },
        },
      ]);
    });
  });
}
