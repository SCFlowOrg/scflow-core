import { describe, expect, spyOn, test } from "bun:test";
import type { MclAccess, ModelActionDefinition } from "@scfloworg/core";
import type { CoreRuntime } from "../index.js";
import { createTestDocument } from "../testing.js";

const SAMPLE_SCHEMAS = {
  schemas: [
    {
      name: "action_task",
      is_root: true,
      properties: [{ name: "title", type: "string", default_value: "" }],
    },
  ],
};

async function titles(mcl: MclAccess, locator: string): Promise<string[]> {
  const { after } = await mcl.runCommand(locator, { kind: "query", schema: "action_task" } as never);
  return (after as Record<string, unknown>[]).map((t) => String(t.title)).sort();
}

/** Creates two tasks, one command each, then optionally fails. */
const addPair: ModelActionDefinition<{ prefix: string; fail?: boolean }, number> = {
  id: "test/add_pair",
  title: "Add a pair of tasks",
  description: "Creates two tasks named after the prefix.",
  parameters: {
    type: "object",
    properties: { prefix: { type: "string" }, fail: { type: "boolean" } },
    required: ["prefix"],
  },
  async execute(access, locator, params) {
    for (const suffix of ["1", "2"]) {
      await access.runCommand(locator, {
        kind: "create",
        schema: "action_task",
        input: { title: `${params.prefix}${suffix}` },
      } as never);
    }
    if (params.fail) throw new Error("action failed");
    return 2;
  },
};

async function inTx<T>(runtime: CoreRuntime, docId: string, fn: () => Promise<T>) {
  await runtime.history.begin(docId, "outer");
  try {
    await fn();
    const { delta } = await runtime.history.prepare(docId);
    await runtime.history.commit(docId);
    return delta;
  } catch (error) {
    await runtime.history.rollback(docId);
    throw error;
  }
}

describe("model actions", () => {
  test("registered actions are listed", async () => {
    const { runtime } = await createTestDocument(SAMPLE_SCHEMAS);
    expect(runtime.getModelActions()).toEqual([]);
    runtime.registerModelActions([addPair]);
    expect(runtime.getModelActions().map((a) => a.id)).toEqual(["test/add_pair"]);
  });

  test("an unknown action is refused", async () => {
    const { runtime, docId } = await createTestDocument(SAMPLE_SCHEMAS);
    await expect(runtime.runModelAction(docId, "test/nope", {})).rejects.toMatchObject({
      code: "unknown_action",
    });
  });

  test("a document that is not open is refused", async () => {
    const { runtime } = await createTestDocument(SAMPLE_SCHEMAS);
    runtime.registerModelActions([addPair]);
    await expect(runtime.runModelAction("ghost", "test/add_pair", { prefix: "x" })).rejects.toMatchObject({
      code: "document_not_open",
    });
  });

  test("outside a transaction, the action commits its own and returns its result", async () => {
    const { runtime, mcl, locator, docId } = await createTestDocument(SAMPLE_SCHEMAS);
    runtime.registerModelActions([addPair]);
    let notified = 0;
    runtime.onChange(docId, () => notified++);

    const result = await runtime.runModelAction<number>(docId, "test/add_pair", { prefix: "a" });

    expect(result).toBe(2);
    expect(await titles(mcl, locator)).toEqual(["a1", "a2"]);
    expect(notified).toBe(1);
  });

  test("outside a transaction, a failing action leaves nothing behind", async () => {
    const { runtime, mcl, locator, docId } = await createTestDocument(SAMPLE_SCHEMAS);
    runtime.registerModelActions([addPair]);

    await expect(
      runtime.runModelAction(docId, "test/add_pair", { prefix: "a", fail: true }),
    ).rejects.toThrow("action failed");

    expect(await titles(mcl, locator)).toEqual([]);
    // No transaction stays open: a later one works.
    await runtime.runModelAction(docId, "test/add_pair", { prefix: "b" });
    expect(await titles(mcl, locator)).toEqual(["b1", "b2"]);
  });

  test("inside an open transaction, the action joins it: one delta, one undo step", async () => {
    const { runtime, mcl, locator, docId } = await createTestDocument(SAMPLE_SCHEMAS);
    runtime.registerModelActions([addPair]);
    let notified = 0;
    runtime.onChange(docId, () => notified++);

    const undo = await inTx(runtime, docId, () => runtime.runModelAction(docId, "test/add_pair", { prefix: "a" }));

    expect(undo).not.toBeNull();
    expect(await titles(mcl, locator)).toEqual(["a1", "a2"]);
    expect(notified).toBe(1);

    await inTx(runtime, docId, () => runtime.history.revert(docId, undo));
    expect(await titles(mcl, locator)).toEqual([]);
  });

  /** Counts the tasks without writing; fails on demand. */
  const countTasks: ModelActionDefinition<{ fail?: boolean }, number> = {
    id: "test/count_tasks",
    title: "Count the tasks",
    description: "Returns the number of tasks.",
    kind: "read",
    parameters: { type: "object", properties: { fail: { type: "boolean" } } },
    async execute(access, locator, params) {
      if (params.fail) throw new Error("read failed");
      return (await titles(access, locator)).length;
    },
  };

  function watchHistory(runtime: CoreRuntime) {
    return {
      begin: spyOn(runtime.history, "begin"),
      commit: spyOn(runtime.history, "commit"),
      rollback: spyOn(runtime.history, "rollback"),
    };
  }

  test("a read action opens no transaction, notifies nobody and returns its result", async () => {
    const { runtime, docId } = await createTestDocument(SAMPLE_SCHEMAS);
    runtime.registerModelActions([addPair, countTasks]);
    await runtime.runModelAction(docId, "test/add_pair", { prefix: "a" });
    let notified = 0;
    runtime.onChange(docId, () => notified++);
    const history = watchHistory(runtime);

    const result = await runtime.runModelAction<number>(docId, "test/count_tasks", {});

    expect(result).toBe(2);
    expect(history.begin).not.toHaveBeenCalled();
    expect(history.commit).not.toHaveBeenCalled();
    expect(history.rollback).not.toHaveBeenCalled();
    expect(notified).toBe(0);
  });

  test("a read action inside an open transaction neither commits nor rolls it back", async () => {
    const { runtime, docId } = await createTestDocument(SAMPLE_SCHEMAS);
    runtime.registerModelActions([addPair, countTasks]);
    const history = watchHistory(runtime);
    let seen = -1;

    await inTx(runtime, docId, async () => {
      await runtime.runModelAction(docId, "test/add_pair", { prefix: "a" });
      seen = await runtime.runModelAction<number>(docId, "test/count_tasks", {});
    });

    expect(seen).toBe(2);
    // only the outer transaction began and committed
    expect(history.begin).toHaveBeenCalledTimes(1);
    expect(history.commit).toHaveBeenCalledTimes(1);
    expect(history.rollback).not.toHaveBeenCalled();
  });

  test("a failing read action is rethrown and leaves the history untouched", async () => {
    const { runtime, mcl, locator, docId } = await createTestDocument(SAMPLE_SCHEMAS);
    runtime.registerModelActions([addPair, countTasks]);
    const history = watchHistory(runtime);

    await expect(runtime.runModelAction(docId, "test/count_tasks", { fail: true })).rejects.toThrow("read failed");

    expect(history.begin).not.toHaveBeenCalled();
    expect(history.commit).not.toHaveBeenCalled();
    expect(history.rollback).not.toHaveBeenCalled();
    // no transaction stays open: a later action works
    await runtime.runModelAction(docId, "test/add_pair", { prefix: "b" });
    expect(await titles(mcl, locator)).toEqual(["b1", "b2"]);
  });

  test("an action declared kind action behaves like one without a kind", async () => {
    const { runtime, mcl, locator, docId } = await createTestDocument(SAMPLE_SCHEMAS);
    runtime.registerModelActions([{ ...addPair, kind: "action" }]);
    let notified = 0;
    runtime.onChange(docId, () => notified++);

    await runtime.runModelAction(docId, "test/add_pair", { prefix: "a" });

    expect(await titles(mcl, locator)).toEqual(["a1", "a2"]);
    expect(notified).toBe(1);
  });

  test("inside an open transaction, a failing action is rolled back by the outer one", async () => {
    const { runtime, mcl, locator, docId } = await createTestDocument(SAMPLE_SCHEMAS);
    runtime.registerModelActions([addPair]);

    await expect(
      inTx(runtime, docId, () => runtime.runModelAction(docId, "test/add_pair", { prefix: "a", fail: true })),
    ).rejects.toThrow("action failed");

    expect(await titles(mcl, locator)).toEqual([]);
  });
});
