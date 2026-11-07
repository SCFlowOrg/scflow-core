import { describe, expect, it } from "vitest";
import { load } from "js-yaml";
import { MCL_CORE_KEY, readModuleManifest, type PersistenceInterface } from "@scfloworg/core";
import { createJsPersistenceInterface } from "@scfloworg/format-js";
import { defineModule, type ModuleBody } from "@scfloworg/module";
import { createEnvironment, type ActionContext } from "../src/index.js";

/** The rules of `docs/environment.md`, on small modules of their own. */

type Row = Record<string, unknown>;

const tasksYaml = (version = "1.0.0", extra = "") => `
name: acme:tasks
namespace: tasks
version: ${version}
mcl: ^1.0
title: Tasks
schemas:
  - name: task
    is_root:
    properties:
      - name: title
        type: string
${extra}
actions:
  - id: tasks/add_task
    title: Add a task
  - id: tasks/add_two
    title: Add two tasks
  - id: tasks/count_tasks
    title: Count the tasks
    kind: read
  - id: tasks/fail
    title: Add a task, then fail
  - id: tasks/escape
    title: Reach another dataset
`;

const notesYaml = `
name: acme:notes
namespace: notes
version: 1.0.0
mcl: ^1.0
title: Notes
dependencies:
  - module: acme:tasks
    version: ^1.0
schemas:
  - name: task_note
    facet_of: tasks.task
    properties:
      - name: text
        type: string
actions:
  - id: notes/add_noted_task
    title: Add a task with a note
`;

const otherYaml = `
name: acme:other
namespace: other
version: 1.0.0
mcl: ^1.0
title: Other
actions:
  - id: other/call_notes
    title: Call an action of a module it does not depend on
`;

const manifest = (yaml: string) => load(yaml) as Record<string, unknown>;

const tasksCode: Record<string, ModuleBody> = {
  async add_task(context: ActionContext, params: { title: string }) {
    const { after } = await context.runCommand(context.locator, {
      create: "tasks.task",
      input: { title: params.title },
    });
    return (after[0] as Row).id;
  },
  async add_two(context: ActionContext) {
    await context.call("tasks/add_task", { title: "one" });
    return context.call("tasks/add_task", { title: "two" });
  },
  async count_tasks(context: ActionContext) {
    const { after } = await context.runCommand(context.locator, { query: "tasks.task" });
    return after.length;
  },
  async fail(context: ActionContext) {
    await context.call("tasks/add_task", { title: "lost" });
    throw new Error("refused by the body");
  },
  async escape(context: ActionContext, params: { locator: string }) {
    return context.runCommand(params.locator, { query: "dataset" });
  },
};

const tasksModule = (version = "1.0.0", extra = "") =>
  defineModule(manifest(tasksYaml(version, extra)), { actions: tasksCode });

const notesModule = () =>
  defineModule(manifest(notesYaml), {
    actions: {
      async add_noted_task(context: ActionContext, params: { title: string; text: string }) {
        const id = (await context.call("tasks/add_task", { title: params.title })) as string;
        await context.runCommand(context.locator, {
          update: "tasks.task",
          filters: { id },
          input: { notes: { text: params.text } },
        });
        return id;
      },
    },
  });

const otherModule = () =>
  defineModule(manifest(otherYaml), {
    actions: {
      call_notes: (context: ActionContext) =>
        context.call("notes/add_noted_task", { title: "x", text: "y" }),
    },
  });

function environment(...formats: PersistenceInterface[]) {
  const env = createEnvironment({
    formats: formats.length > 0 ? formats : [createJsPersistenceInterface()],
  });
  env.modules.install(tasksModule());
  env.modules.install(notesModule());
  return env;
}

describe("createEnvironment", () => {
  it("holds the formats it is given, and refuses two of one name", () => {
    const js = createJsPersistenceInterface();
    expect(createEnvironment({ formats: [js] }).formats).toEqual([js]);
    expect(() => createEnvironment({ formats: [js, createJsPersistenceInterface()] })).toThrow(
      expect.objectContaining({ code: "duplicate_name" }),
    );
  });

  it("shares nothing with another environment", async () => {
    const one = environment();
    const two = environment();
    await one.datasets.create({ locator: "js:plant", modules: ["acme:tasks"] });
    expect(two.datasets.get("js:plant")).toBeUndefined();
    await expect(two.datasets.open("js:plant")).rejects.toMatchObject({
      code: "dataset_not_found",
    });
    expect(createEnvironment({ formats: [createJsPersistenceInterface()] }).modules.list()).toEqual(
      [],
    );
  });

  it("refuses a locator of a format it does not hold", async () => {
    const env = environment();
    await expect(env.datasets.open("other:plant")).rejects.toMatchObject({
      code: "unknown_persistent_format",
    });
  });
});

describe("the catalogue", () => {
  it("installs a module given by defineModule, with its code", () => {
    const env = createEnvironment({ formats: [createJsPersistenceInterface()] });
    const installed = env.modules.install(tasksModule());
    const expected = readModuleManifest(tasksYaml());
    expect(installed).toMatchObject({ key: "acme:tasks", version: "1.0.0" });
    expect(installed.manifest).toEqual(expected);
    expect([...installed.actions.keys()].sort()).toEqual([
      "tasks/add_task",
      "tasks/add_two",
      "tasks/count_tasks",
      "tasks/escape",
      "tasks/fail",
    ]);
    expect(env.modules.get("acme:tasks")).toBe(installed);
    expect(env.modules.list()).toEqual([installed]);
  });

  it("returns the installed module for the same module installed again", () => {
    const env = environment();
    expect(env.modules.install(tasksModule())).toBe(env.modules.get("acme:tasks"));
  });

  it("holds one version of each module", () => {
    const env = environment();
    expect(() => env.modules.install(tasksModule("1.1.0"))).toThrow(
      expect.objectContaining({ code: "duplicate_name" }),
    );
    expect(() =>
      env.modules.install(tasksModule("1.0.0", "      - name: done\n        type: boolean")),
    ).toThrow(expect.objectContaining({ code: "duplicate_name" }));
    expect(env.modules.get("acme:tasks")!.version).toBe("1.0.0");
  });

  it("refuses a second module with an installed namespace", () => {
    const env = environment();
    const clash = defineModule({ ...manifest(otherYaml), namespace: "tasks", actions: [] });
    expect(() => env.modules.install(clash)).toThrow(
      expect.objectContaining({ code: "namespace_conflict" }),
    );
  });

  it("refuses mcl:core and local modules", () => {
    const env = environment();
    const local = defineModule({
      name: "local:plant",
      namespace: "plant",
      version: "1.0.0",
      mcl: "^1.0",
    });
    expect(() => env.modules.install(local)).toThrow(
      expect.objectContaining({ code: "constraint_violation" }),
    );
    const core = defineModule({
      name: MCL_CORE_KEY,
      namespace: "core",
      version: "1.0.0",
      mcl: "^1.0",
    });
    expect(() => env.modules.install(core)).toThrow(
      expect.objectContaining({ code: "duplicate_name" }),
    );
  });

  it("checks the code against the manifest", () => {
    const env = createEnvironment({ formats: [createJsPersistenceInterface()] });
    const undeclared = defineModule(manifest(tasksYaml()), {
      actions: { ...tasksCode, extra: () => 1 },
    });
    expect(() => env.modules.install(undeclared)).toThrow(
      expect.objectContaining({ code: "constraint_violation" }),
    );
    const missing = defineModule(manifest(tasksYaml()), {
      actions: { add_task: tasksCode.add_task },
    });
    expect(() => env.modules.install(missing)).toThrow(
      expect.objectContaining({ code: "constraint_violation" }),
    );
    expect(env.modules.list()).toEqual([]);
  });

  it("installs modules in any order", () => {
    const env = createEnvironment({ formats: [createJsPersistenceInterface()] });
    env.modules.install(notesModule());
    env.modules.install(tasksModule());
    expect(env.modules.list().map((module) => module.key)).toEqual(["acme:notes", "acme:tasks"]);
  });
});

describe("datasets", () => {
  it("creates a dataset with the modules named and their dependencies", async () => {
    const env = environment();
    const dataset = await env.datasets.create({
      locator: "js:plant",
      name: "plant",
      modules: ["acme:notes"],
    });
    expect(dataset.locator).toBe("js:plant");
    expect(dataset.readOnly).toBe(false);
    expect(dataset.modules).toEqual([
      { module: "acme:tasks", version: "1.0.0", installed: "1.0.0", state: "current" },
      { module: "acme:notes", version: "1.0.0", installed: "1.0.0", state: "current" },
    ]);
    expect(await dataset.info()).toMatchObject({
      name: "plant",
      modules: [{ module: "acme:tasks" }, { module: "acme:notes" }],
    });
    expect(env.datasets.get("js:plant")).toBe(dataset);
    expect(env.datasets.list()).toEqual([dataset]);
  });

  it("chooses a free locator in the first format when none is given", async () => {
    const env = environment();
    const first = await env.datasets.create({ modules: ["acme:tasks"] });
    const second = await env.datasets.create({ modules: [MCL_CORE_KEY, "acme:tasks"] });
    expect([first.locator, second.locator]).toEqual(["js:dataset-1", "js:dataset-2"]);
    expect(await first.info()).toMatchObject({ name: "dataset" });
    expect(second.modules.map((module) => module.module)).toEqual(["acme:tasks"]);
  });

  it("refuses a module that is not installed, creating nothing", async () => {
    const env = createEnvironment({ formats: [createJsPersistenceInterface()] });
    env.modules.install(notesModule());
    await expect(
      env.datasets.create({ locator: "js:plant", modules: ["acme:notes"] }),
    ).rejects.toMatchObject({
      code: "key_not_found",
    });
    await expect(
      env.datasets.create({ locator: "js:plant", modules: ["acme:missing"] }),
    ).rejects.toMatchObject({
      code: "key_not_found",
    });
    await expect(env.datasets.open("js:plant")).rejects.toMatchObject({
      code: "dataset_not_found",
    });
  });

  it("opens a dataset once, and again after it is closed", async () => {
    const env = environment();
    const created = await env.datasets.create({ locator: "js:plant", modules: ["acme:tasks"] });
    expect(await env.datasets.open("js:plant")).toBe(created);
    await created.close();
    expect(env.datasets.get("js:plant")).toBeUndefined();
    const reopened = await env.datasets.open("js:plant");
    expect(reopened).not.toBe(created);
    expect(reopened.modules).toEqual(created.modules);
  });

  it("saves and restores a dataset with its modules embedded, in another environment", async () => {
    const env = environment();
    const dataset = await env.datasets.create({ locator: "js:plant", modules: ["acme:notes"] });
    await dataset.run("notes/add_noted_task", { title: "Ship", text: "by Friday" });
    const dump = await dataset.dump("yaml");

    const other = environment();
    const restored = await other.datasets.restore("js:copy", dump, "yaml");
    expect(restored.readOnly).toBe(false);
    expect(restored.modules.map((module) => module.state)).toEqual(["current", "current"]);
    const { after } = await restored.query({ query: "tasks.task" });
    expect(after).toMatchObject([{ title: "Ship", notes: { text: "by Friday" } }]);
  });
});

describe("opening against the catalogue", () => {
  async function savedWith(...modules: ReturnType<typeof defineModule>[]) {
    const env = createEnvironment({ formats: [createJsPersistenceInterface()] });
    for (const module of modules) env.modules.install(module);
    const dataset = await env.datasets.create({
      locator: "js:plant",
      modules: modules.map((m) => String(m.manifest.name)),
    });
    await dataset.run("tasks/add_task", { title: "Ship" });
    return dataset.dump("json");
  }

  const restoreIn = async (dump: string, ...modules: ReturnType<typeof defineModule>[]) => {
    const env = createEnvironment({ formats: [createJsPersistenceInterface()] });
    for (const module of modules) env.modules.install(module);
    return env.datasets.restore("js:plant", dump, "json");
  };

  it("opens read only a dataset whose module is missing", async () => {
    const dataset = await restoreIn(await savedWith(tasksModule()));
    expect(dataset.readOnly).toBe(true);
    expect(dataset.modules).toEqual([
      { module: "acme:tasks", version: "1.0.0", installed: null, state: "missing" },
    ]);
    expect((await dataset.query({ query: "tasks.task" })).after).toHaveLength(1);
    await expect(dataset.run("tasks/add_task", { title: "x" })).rejects.toMatchObject({
      code: "unknown_action",
    });
  });

  it("opens read only a dataset behind, ahead of or beside the installed version", async () => {
    const outdated = await restoreIn(await savedWith(tasksModule()), tasksModule("1.1.0"));
    expect(outdated.modules[0]).toMatchObject({
      version: "1.0.0",
      installed: "1.1.0",
      state: "outdated",
    });
    const ahead = await restoreIn(await savedWith(tasksModule("2.0.0")), tasksModule("1.1.0"));
    expect(ahead.modules[0]).toMatchObject({
      version: "2.0.0",
      installed: "1.1.0",
      state: "ahead",
    });
    const changed = await restoreIn(
      await savedWith(tasksModule()),
      tasksModule("1.0.0", "      - name: done\n        type: boolean"),
    );
    expect(changed.modules[0]).toMatchObject({
      version: "1.0.0",
      installed: "1.0.0",
      state: "changed",
    });
    for (const dataset of [outdated, ahead, changed]) expect(dataset.readOnly).toBe(true);
  });

  it("runs read actions on a read-only dataset and refuses the others", async () => {
    const dataset = await restoreIn(await savedWith(tasksModule()), tasksModule("1.1.0"));
    expect((await dataset.run("tasks/count_tasks")).result).toBe(1);
    await expect(dataset.run("tasks/add_task", { title: "x" })).rejects.toMatchObject({
      code: "read_only_dataset",
    });
  });
});

describe("running an action", () => {
  it("runs the body in one transaction and returns its result and delta", async () => {
    const env = environment();
    const dataset = await env.datasets.create({ locator: "js:plant", modules: ["acme:tasks"] });
    const outcome = await dataset.run("tasks/add_two");
    expect(outcome.changed).toBe(true);
    expect(outcome.delta).not.toBeNull();
    const { after } = await dataset.query({ query: "tasks.task" });
    expect(after.map((task) => (task as Row).title).sort()).toEqual(["one", "two"]);
    expect(outcome.result).toBe(after.find((task) => (task as Row).title === "two")!.id);
    expect(await dataset.info()).toMatchObject({ data_minor_version: 2 });
  });

  it("rolls the transaction back when the body throws", async () => {
    const env = environment();
    const dataset = await env.datasets.create({ locator: "js:plant", modules: ["acme:tasks"] });
    await expect(dataset.run("tasks/fail")).rejects.toThrow("refused by the body");
    expect((await dataset.query({ query: "tasks.task" })).after).toEqual([]);
    expect(await dataset.info()).toMatchObject({ data_minor_version: 0 });
    await dataset.run("tasks/add_task", { title: "after" });
    expect((await dataset.query({ query: "tasks.task" })).after).toHaveLength(1);
  });

  it("runs a read action in no transaction", async () => {
    const env = environment();
    const dataset = await env.datasets.create({ locator: "js:plant", modules: ["acme:tasks"] });
    await dataset.run("tasks/add_task", { title: "Ship" });
    expect(await dataset.run("tasks/count_tasks")).toEqual({
      result: 1,
      changed: false,
      delta: null,
    });
  });

  it("runs the actions of one dataset one at a time", async () => {
    const env = environment();
    const dataset = await env.datasets.create({ locator: "js:plant", modules: ["acme:tasks"] });
    const [failed, added] = await Promise.allSettled([
      dataset.run("tasks/fail"),
      dataset.run("tasks/add_task", { title: "kept" }),
    ]);
    expect(failed.status).toBe("rejected");
    expect(added.status).toBe("fulfilled");
    const { after } = await dataset.query({ query: "tasks.task" });
    expect(after).toMatchObject([{ title: "kept" }]);
  });

  it("refuses an action that no module of the dataset declares", async () => {
    const env = environment();
    env.modules.install(otherModule());
    const dataset = await env.datasets.create({ locator: "js:plant", modules: ["acme:tasks"] });
    await expect(dataset.run("tasks/nothing")).rejects.toMatchObject({ code: "unknown_action" });
    await expect(
      dataset.run("notes/add_noted_task", { title: "x", text: "y" }),
    ).rejects.toMatchObject({ code: "unknown_action" });
    await expect(dataset.run("other/call_notes")).rejects.toMatchObject({ code: "unknown_action" });
  });

  it("runs on a format without transactions, each command on its own", async () => {
    const js = createJsPersistenceInterface("nt");
    const noTransactions: PersistenceInterface = { ...js, supportsTransactions: false };
    const env = environment(noTransactions);
    const dataset = await env.datasets.create({ modules: ["acme:tasks"] });
    expect(dataset.locator).toBe("nt:dataset-1");
    const outcome = await dataset.run("tasks/add_task", { title: "Ship" });
    expect(outcome).toMatchObject({ changed: true, delta: null });
    await expect(dataset.run("tasks/fail")).rejects.toThrow("refused by the body");
    expect((await dataset.query({ query: "tasks.task" })).after).toHaveLength(2);
  });
});

describe("the context of an action", () => {
  it("reaches only the dataset of the action", async () => {
    const env = environment();
    const dataset = await env.datasets.create({ locator: "js:plant", modules: ["acme:tasks"] });
    await env.datasets.create({ locator: "js:other", modules: ["acme:tasks"] });
    await expect(dataset.run("tasks/escape", { locator: "js:other" })).rejects.toMatchObject({
      code: "dataset_not_found",
    });
    expect((await dataset.run("tasks/escape", { locator: "js:plant" })).result).toMatchObject({
      after: [{ name: "dataset" }],
    });
  });

  it("calls the actions of its module and of its dependencies, in the same transaction", async () => {
    const env = environment();
    const dataset = await env.datasets.create({ locator: "js:plant", modules: ["acme:notes"] });
    const { result, changed } = await dataset.run("notes/add_noted_task", {
      title: "Ship",
      text: "by Friday",
    });
    expect(changed).toBe(true);
    const { after } = await dataset.query({ query: "tasks.task", filters: { id: result } });
    expect(after).toMatchObject([{ title: "Ship", notes: { text: "by Friday" } }]);
    expect(await dataset.info()).toMatchObject({ data_minor_version: 2 });
  });

  it("refuses a call to a module that is not a dependency", async () => {
    const env = environment();
    env.modules.install(otherModule());
    const dataset = await env.datasets.create({
      locator: "js:plant",
      modules: ["acme:notes", "acme:other"],
    });
    await expect(dataset.run("other/call_notes")).rejects.toMatchObject({ code: "unknown_action" });
    expect((await dataset.query({ query: "tasks.task" })).after).toEqual([]);
  });

  it("names the running action", async () => {
    const env = createEnvironment({ formats: [createJsPersistenceInterface()] });
    const seen: string[] = [];
    env.modules.install(
      defineModule(manifest(tasksYaml()), {
        actions: {
          ...tasksCode,
          add_task: (context: ActionContext) => void seen.push(context.action),
          add_two: async (context: ActionContext) => {
            seen.push(context.action);
            await context.call("tasks/add_task");
          },
        },
      }),
    );
    const dataset = await env.datasets.create({ modules: ["acme:tasks"] });
    await dataset.run("tasks/add_two");
    expect(seen).toEqual(["tasks/add_two", "tasks/add_task"]);
  });
});
