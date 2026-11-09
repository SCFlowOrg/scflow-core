import { describe, expect, it } from "vitest";
import { ModelError } from "../src/errors.js";
import { createApiSession, createScriptSession, registerPersistentFormat, runCommand, runScript } from "../src/testing.js";
import { processSchemaDescription } from "../src/schemaProcessing.js";
import type { TypeResolutionContext } from "../src/schemaProcessing.js";
import type { AuthoredCommand, Key, NormalizedSchema, PersistenceInterface, TransientObject, TransientValue } from "../src/types.js";

/**
 * Tests for the optional `lock(rest)` of the Persistence Interface and the
 * generic layer's use of it — the `lock` doc comment of `PersistenceInterface`
 * and the Write lock bullet of `docs/sessions.md`.
 *
 * `fakeFormat` is an in-memory PersistenceInterface whose dataset reads and
 * writes yield to the event loop, so two writers that are not serialized
 * interleave their read-modify-write of the version counters and lose an
 * increment. Its `lock` is a per-`rest` promise queue that counts how many
 * holders are inside at once.
 */

let formatCounter = 0;

interface LockStats {
  holders: number;
  maxHolders: number;
  acquired: number;
  released: number;
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function fakeFormat(withLock = true): { impl: PersistenceInterface; stats: LockStats } {
  const name = `test-lock-fmt-${++formatCounter}`;
  const datasets = new Map<string, { info: TransientObject; stores: Map<string, Map<Key, TransientValue>> }>();
  const stats: LockStats = { holders: 0, maxHolders: 0, acquired: 0, released: 0 };
  const queues = new Map<string, Promise<void>>();

  function getState(rest: string) {
    const state = datasets.get(rest);
    if (!state) throw new ModelError("dataset_not_found", `no "${name}" dataset at "${rest}"`);
    return state;
  }

  function getStore(rest: string, schema: string): Map<Key, TransientValue> {
    const state = getState(rest);
    let store = state.stores.get(schema);
    if (!store) {
      store = new Map();
      state.stores.set(schema, store);
    }
    return store;
  }

  const impl: PersistenceInterface = {
    name,
    supportsTransactions: true,

    async datasetExists(rest) {
      return datasets.has(rest);
    },
    async createDataset(rest, dsName) {
      const now = new Date().toISOString();
      const info: TransientObject = {
        name: dsName,
        model_major_version: 0,
        model_minor_version: 0,
        data_major_version: 0,
        data_minor_version: 0,
        created_at: now,
        updated_at: now,
      };
      datasets.set(rest, { info, stores: new Map() });
      return info;
    },
    async getDataset(rest) {
      await tick();
      return { ...getState(rest).info };
    },
    async updateDataset(rest, patch) {
      await tick();
      const state = getState(rest);
      Object.assign(state.info, patch as object);
      return { ...state.info };
    },
    async deleteDataset(rest) {
      getState(rest);
      datasets.delete(rest);
    },
    async getInstance(rest, schema, key) {
      const value = getStore(rest, schema).get(key);
      return value === undefined ? null : value;
    },
    async listInstances(rest, schema) {
      return [...getStore(rest, schema).values()];
    },
    async putInstance(rest, schema, key, instance) {
      await tick();
      getStore(rest, schema).set(key, instance);
    },
    async deleteInstance(rest, schema, key) {
      getStore(rest, schema).delete(key);
    },
  };

  if (withLock) {
    impl.lock = async (rest) => {
      const prior = queues.get(rest) ?? Promise.resolve();
      let open!: () => void;
      const gate = new Promise<void>((resolve) => (open = resolve));
      queues.set(
        rest,
        prior.then(() => gate),
      );
      await prior;
      stats.holders += 1;
      stats.acquired += 1;
      stats.maxHolders = Math.max(stats.maxHolders, stats.holders);
      return async () => {
        stats.holders -= 1;
        stats.released += 1;
        open();
      };
    };
  }

  return { impl, stats };
}

/** Seeds a plain "note" schema directly into `impl`'s store, so commands on it need no upgrade locator. */
async function seedNoteSchema(impl: PersistenceInterface, rest: string): Promise<void> {
  const schemas = new Map<string, NormalizedSchema>();
  const ctx: TypeResolutionContext = { resolveSchema: (n) => schemas.get(n), resolveScalarType: () => undefined };
  const note = processSchemaDescription(
    { name: "note", shared_by_name: true, properties: [{ name: "name", type: "identifier" }, { name: "title", type: "string" }] },
    ctx,
  );
  await impl.putInstance(rest, "schema", "note", note as unknown as TransientValue, {});
}

async function setup(withLock = true) {
  const { impl, stats } = fakeFormat(withLock);
  registerPersistentFormat(impl);
  await impl.createDataset("d1", "Test");
  await seedNoteSchema(impl, "d1");
  return { impl, stats, locator: `${impl.name}:d1` };
}

function create(name: string): AuthoredCommand {
  return { kind: "create", schema: "note", input: { name, title: name } };
}

async function dataVersion(impl: PersistenceInterface): Promise<number> {
  return ((await impl.getDataset("d1")) as TransientObject).data_minor_version as number;
}

async function noteCount(impl: PersistenceInterface): Promise<number> {
  return (await impl.listInstances("d1", "note", {})).length;
}

describe("lock: concurrent writers", () => {
  it("two sessions writing at once lose no version increment", async () => {
    const { impl, stats, locator } = await setup();
    const a = createApiSession();
    const b = createApiSession();

    await Promise.all([
      ...[1, 2, 3, 4, 5].map((i) => a.runCommand(locator, create(`a${i}`))),
      ...[1, 2, 3, 4, 5].map((i) => b.runCommand(locator, create(`b${i}`))),
    ]);

    expect(await dataVersion(impl)).toBe(10);
    expect(await noteCount(impl)).toBe(10);
    expect(stats.maxHolders).toBe(1);
    expect(stats.holders).toBe(0);
  });

  it("the free runCommand and runScript serialize against each other", async () => {
    const { impl, stats, locator } = await setup();

    await Promise.all([
      runCommand(locator, create("c1")),
      runScript(locator, { commands: [create("s1")] }),
      runCommand(locator, create("c2")),
      runScript(locator, { commands: [create("s2")] }),
    ]);

    expect(await dataVersion(impl)).toBe(4);
    expect(stats.maxHolders).toBe(1);
    expect(stats.holders).toBe(0);
  });

  it("a ScriptSession's run takes the lock, plain and through an ApiSession", async () => {
    const { impl, stats, locator } = await setup();
    const api = createApiSession();
    const plain = await createScriptSession(locator);
    const viaApi = await api.createScriptSession(locator);

    await Promise.all([plain.run(create("p1")), viaApi.run(create("v1")), plain.run(create("p2")), viaApi.run(create("v2"))]);

    expect(await dataVersion(impl)).toBe(4);
    expect(stats.maxHolders).toBe(1);
    expect(stats.holders).toBe(0);
  });

  it("releases the lock after a command that throws", async () => {
    const { impl, stats, locator } = await setup();
    const session = createApiSession();

    await expect(session.runCommand(locator, { kind: "create", schema: "no_such_schema", input: { name: "x" } })).rejects.toThrow();
    await expect(runCommand(locator, { kind: "create", schema: "no_such_schema", input: { name: "x" } })).rejects.toThrow();
    expect(stats.holders).toBe(0);

    await session.runCommand(locator, create("after"));
    expect(await noteCount(impl)).toBe(1);
    expect(stats.holders).toBe(0);
  });

  it("a format without lock keeps working, one caller at a time", async () => {
    const { impl, stats, locator } = await setup(false);

    await createApiSession().runCommand(locator, create("n1"));
    await runCommand(locator, create("n2"));

    expect(impl.lock).toBeUndefined();
    expect(stats.acquired).toBe(0);
    expect(await noteCount(impl)).toBe(2);
  });
});

describe("lock: transactions", () => {
  it("is held from beginTransaction to commitTransaction and taken once for the commands inside", async () => {
    const { impl, stats, locator } = await setup();
    const session = createApiSession();

    const tx = await session.beginTransaction(locator);
    expect(stats.holders).toBe(1);
    await session.runCommand(locator, create("t1"));
    await session.runScript(locator, { commands: [create("t2")] });
    expect(stats.acquired).toBe(1);
    expect(stats.holders).toBe(1);

    await session.commitTransaction(locator, tx);
    expect(stats.holders).toBe(0);
    expect(stats.released).toBe(1);
    expect(await dataVersion(impl)).toBe(2);
  });

  it("a nested beginTransaction does not take the lock again and the outermost commit releases it", async () => {
    const { stats, locator } = await setup();
    const session = createApiSession();

    const outer = await session.beginTransaction(locator);
    const inner = await session.beginTransaction(locator);
    await session.commitTransaction(locator, inner);
    expect(stats.holders).toBe(1);

    await session.commitTransaction(locator, outer);
    expect(stats.acquired).toBe(1);
    expect(stats.holders).toBe(0);
  });

  it("is released by rollbackTransaction and the changes are undone", async () => {
    const { impl, stats, locator } = await setup();
    const session = createApiSession();

    const tx = await session.beginTransaction(locator);
    await session.runCommand(locator, create("t1"));
    await session.rollbackTransaction(locator, tx);

    expect(stats.holders).toBe(0);
    expect(await noteCount(impl)).toBe(0);
    expect(await dataVersion(impl)).toBe(0);
  });

  it("is released after a command that throws inside a transaction is rolled back", async () => {
    const { stats, locator } = await setup();
    const session = createApiSession();

    const tx = await session.beginTransaction(locator);
    await expect(session.runCommand(locator, { kind: "create", schema: "no_such_schema", input: { name: "x" } })).rejects.toThrow();
    expect(stats.holders).toBe(1);
    await session.rollbackTransaction(locator, tx);

    expect(stats.holders).toBe(0);
  });

  it("is released by prepareTransaction followed by commitTransaction", async () => {
    const { stats, locator } = await setup();
    const session = createApiSession();

    const tx = await session.beginTransaction(locator);
    await session.runCommand(locator, create("t1"));
    await session.prepareTransaction(locator, tx);
    expect(stats.holders).toBe(1);
    await session.commitTransaction(locator, tx);

    expect(stats.holders).toBe(0);
  });

  it("is released by invalidate and by a session deleteDataset when a transaction is open", async () => {
    const { stats, locator } = await setup();
    const session = createApiSession();

    await session.beginTransaction(locator);
    session.invalidate(locator);
    await session.runCommand(locator, { kind: "query", schema: "note" });
    await tick();
    expect(stats.holders).toBe(0);

    await session.beginTransaction(locator);
    expect(stats.holders).toBe(1);
    await session.deleteDataset(locator);
    expect(stats.holders).toBe(0);
  });

  it("makes another session's writer wait until the transaction ends", async () => {
    const { impl, stats, locator } = await setup();
    const a = createApiSession();
    const b = createApiSession();

    const tx = await a.beginTransaction(locator);
    await a.runCommand(locator, create("a1"));

    let bDone = false;
    const bRun = b.runCommand(locator, create("b1")).then(() => {
      bDone = true;
    });
    for (let i = 0; i < 10; i++) await tick();
    expect(bDone).toBe(false);

    await a.commitTransaction(locator, tx);
    await bRun;

    expect(bDone).toBe(true);
    expect(await dataVersion(impl)).toBe(2);
    expect(stats.maxHolders).toBe(1);
    expect(stats.holders).toBe(0);
  });
});
