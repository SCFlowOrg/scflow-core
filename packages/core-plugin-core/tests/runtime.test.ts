import { describe, expect, test } from "bun:test";
import type { MclAccess } from "@scfloworg/core";
import { createCoreRuntime, type CoreRuntime } from "../index.js";
import { createTestDocument } from "../testing.js";

/** Self-contained fixture: one root schema and tiny MCL helpers. */
const SAMPLE_SCHEMAS = {
  schemas: [
    {
      name: "sample_task",
      is_root: true,
      properties: [
        { name: "title", type: "string", default_value: "" },
        { name: "done", type: "boolean", default_value: false },
      ],
    },
  ],
};

interface Task { id: string; title: string; done: boolean }
const toTask = (v: unknown): Task => {
  const r = v as Record<string, unknown>;
  return { id: String(r.id), title: String(r.title ?? ""), done: Boolean(r.done) };
};
async function listTasks(mcl: MclAccess, locator: string): Promise<Task[]> {
  const { after } = await mcl.runCommand(locator, { kind: "query", schema: "sample_task" } as never);
  return (after as unknown[]).map(toTask);
}
async function addTask(mcl: MclAccess, locator: string, input: Partial<Task>): Promise<Task> {
  const { after } = await mcl.runCommand(locator, { kind: "create", schema: "sample_task", input } as never);
  return toTask((after as unknown[])[0]);
}
async function updateTask(mcl: MclAccess, locator: string, id: string, input: Partial<Task>) {
  await mcl.runCommand(locator, { kind: "update", schema: "sample_task", filters: { id }, input } as never);
}
async function removeTasks(mcl: MclAccess, locator: string, ids: string[]) {
  await mcl.runCommand(locator, { kind: "delete", schema: "sample_task", filters: { or: ids.map((id) => ({ id })) } } as never);
}

async function inTx(runtime: CoreRuntime, docId: string, fn: () => Promise<void>) {
  await runtime.history.begin(docId, "edit");
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

describe("core-plugin runtime", () => {
  test("create, edit and query a document through injected MclAccess", async () => {
    const { mcl, locator } = await createTestDocument(SAMPLE_SCHEMAS);
    const t = await addTask(mcl, locator, { title: "Ship" });
    await updateTask(mcl, locator, t.id, { done: true });
    expect(await listTasks(mcl, locator)).toEqual([{ id: t.id, title: "Ship", done: true }]);
    await removeTasks(mcl, locator, [t.id]);
    expect(await listTasks(mcl, locator)).toEqual([]);
  });

  test("undo / redo with core transactions", async () => {
    const { runtime, mcl, locator, docId } = await createTestDocument(SAMPLE_SCHEMAS);
    const undo = await inTx(runtime, docId, async () => {
      await addTask(mcl, locator, { title: "A" });
    });
    expect(undo).not.toBeNull();
    expect((await listTasks(mcl, locator)).length).toBe(1);

    const redo = await inTx(runtime, docId, () => runtime.history.revert(docId, undo));
    expect(await listTasks(mcl, locator)).toEqual([]);

    await inTx(runtime, docId, () => runtime.history.revert(docId, redo));
    expect((await listTasks(mcl, locator)).map((t) => t.title)).toEqual(["A"]);
  });

  test("rollback discards changes", async () => {
    const { runtime, mcl, locator, docId } = await createTestDocument(SAMPLE_SCHEMAS);
    await expect(
      inTx(runtime, docId, async () => {
        await addTask(mcl, locator, { title: "lost" });
        throw new Error("veto");
      }),
    ).rejects.toThrow("veto");
    expect(await listTasks(mcl, locator)).toEqual([]);
  });

  test("stale delta is reported", async () => {
    const { runtime, mcl, locator, docId } = await createTestDocument(SAMPLE_SCHEMAS);
    const undo = await inTx(runtime, docId, async () => {
      await addTask(mcl, locator, { title: "A" });
    });
    await inTx(runtime, docId, async () => {
      await addTask(mcl, locator, { title: "B" });
    });
    let error: unknown;
    try {
      await inTx(runtime, docId, () => runtime.history.revert(docId, undo));
    } catch (e) {
      error = e;
    }
    expect((error as { code?: string }).code).toBe("stale_delta");
  });

  test("save and load round-trip", async () => {
    const { runtime, mcl, locator, docId } = await createTestDocument(SAMPLE_SCHEMAS);
    await addTask(mcl, locator, { title: "Keep" });
    const data = await runtime.saveDocument(docId);
    await runtime.disposeDocument(docId);
    const reopened = await runtime.loadDocument("again", JSON.parse(JSON.stringify(data)));
    expect((await listTasks(mcl, reopened)).map((t) => t.title)).toEqual(["Keep"]);
  });

  test("filtered access refuses foreign locators and writes to the built-in", async () => {
    const { runtime, mcl } = await createTestDocument(SAMPLE_SCHEMAS);
    await expect(mcl.runCommand("js:elsewhere/x", { kind: "query", schema: "sample_task" } as never)).rejects.toThrow();
    await expect(
      mcl.runCommand(runtime.builtin, { kind: "create", schema: "sample_task", input: {} } as never),
    ).rejects.toThrow();
    const res = await mcl.runCommand(runtime.builtin, { kind: "query", schema: "schema" } as never);
    expect(Array.isArray(res.after)).toBe(true);
  });

  test("schema clash between plugins is refused", async () => {
    const runtime = createCoreRuntime({ area: "clash" });
    await runtime.init();
    await runtime.registerSchemas("a", SAMPLE_SCHEMAS);
    await expect(runtime.registerSchemas("b", SAMPLE_SCHEMAS)).rejects.toThrow("already registered");
  });

  test("change notifications fire on commit", async () => {
    const { runtime, mcl, locator, docId } = await createTestDocument(SAMPLE_SCHEMAS);
    let count = 0;
    runtime.onChange(docId, () => count++);
    await inTx(runtime, docId, async () => {
      await addTask(mcl, locator, { title: "x" });
      expect(count).toBe(0);
    });
    expect(count).toBe(1);
  });
});
