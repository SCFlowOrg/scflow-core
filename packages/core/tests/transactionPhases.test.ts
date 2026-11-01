import { describe, expect, it } from "vitest";
import { ModelError } from "../src/errors.js";
import { createApiSession, registerPersistentFormat } from "../src/index.js";
import { processSchemaDescription } from "../src/schemaProcessing.js";
import type { TypeResolutionContext } from "../src/schemaProcessing.js";
import type { AuthoredCommand, Key, NormalizedSchema, PersistenceInterface, TransientObject, TransientValue } from "../src/types.js";

/**
 * Tests for the two-phase commit and the session queue of ApiSession —
 * the Two phases and Queue bullets of `docs/sessions.md`.
 */

let formatCounter = 0;

function fakeFormat(supportsTransactions = true): PersistenceInterface {
  const name = `test-phase-fmt-${++formatCounter}`;
  const datasets = new Map<string, { info: TransientObject; stores: Map<string, Map<Key, TransientValue>> }>();

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

  return {
    name,
    supportsTransactions,
    areaOf: (rest) => rest,
    builtinRestFor: () => "no-builtin",
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
      return { ...getState(rest).info };
    },
    async updateDataset(rest, patch) {
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
      getStore(rest, schema).set(key, instance);
    },
    async deleteInstance(rest, schema, key) {
      getStore(rest, schema).delete(key);
    },
  };
}

async function seedNoteSchema(impl: PersistenceInterface, rest: string): Promise<void> {
  const schemas = new Map<string, NormalizedSchema>();
  const ctx: TypeResolutionContext = { resolveSchema: (n) => schemas.get(n), resolveScalarType: () => undefined };
  const note = processSchemaDescription(
    { name: "note", shared_by_name: true, properties: [{ name: "name", type: "identifier" }, { name: "title", type: "string" }] },
    ctx,
  );
  await impl.putInstance(rest, "schema", "note", note as unknown as TransientValue, {});
}

async function setup(supportsTransactions = true) {
  const impl = fakeFormat(supportsTransactions);
  registerPersistentFormat(impl);
  await impl.createDataset("d1", "Test");
  await seedNoteSchema(impl, "d1");
  return { impl, session: createApiSession(), locator: `${impl.name}:d1` };
}

const createNote = (name: string, title = name): AuthoredCommand => ({ kind: "create", schema: "note", input: [{ name, title }] });
const queryNotes: AuthoredCommand = { kind: "query", schema: "note" };

async function expectCode(fn: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await fn();
    expect.fail(`expected a ${code}`);
  } catch (err) {
    expect(err).toBeInstanceOf(ModelError);
    expect((err as ModelError).code).toBe(code);
  }
}

describe("ApiSession two-phase commit", () => {
  it("prepare then commit finalizes the transaction", async () => {
    const { session, locator } = await setup();
    const tx = await session.beginTransaction(locator);
    await session.runCommand(locator, createNote("n1"));
    await session.prepareTransaction(locator, tx);
    await session.commitTransaction(locator, tx);
    expect((await session.runCommand(locator, queryNotes)).after).toHaveLength(1);
    await expectCode(() => session.commitTransaction(locator, tx), "no_transaction_in_progress");
  });

  it("a prepared transaction refuses commands, a nested begin and a second prepare", async () => {
    const { session, locator } = await setup();
    const tx = await session.beginTransaction(locator);
    await session.runCommand(locator, createNote("n1"));
    await session.prepareTransaction(locator, tx);
    await expectCode(() => session.runCommand(locator, createNote("n2")), "transaction_prepared");
    await expectCode(() => session.runScript(locator, { commands: [createNote("n3")] }), "transaction_prepared");
    await expectCode(() => session.createScriptSession(locator), "transaction_prepared");
    await expectCode(() => session.beginTransaction(locator), "transaction_prepared");
    await expectCode(() => session.prepareTransaction(locator, tx), "transaction_prepared");
    await session.commitTransaction(locator, tx);
    expect((await session.runCommand(locator, queryNotes)).after).toHaveLength(1);
  });

  it("a ScriptSession opened before prepare refuses to run once prepared", async () => {
    const { session, locator } = await setup();
    const scriptSession = await session.createScriptSession(locator);
    const tx = await session.beginTransaction(locator);
    await session.prepareTransaction(locator, tx);
    await expectCode(() => scriptSession.run(createNote("n1")), "transaction_prepared");
    await session.rollbackTransaction(locator, tx);
  });

  it("a prepared transaction can still be rolled back as a whole", async () => {
    const { session, locator } = await setup();
    const tx = await session.beginTransaction(locator);
    await session.runCommand(locator, createNote("n1"));
    await session.prepareTransaction(locator, tx);
    await session.rollbackTransaction(locator, tx);
    expect((await session.runCommand(locator, queryNotes)).after).toHaveLength(0);
  });

  it("a rollback restores the versions the transaction's commands moved", async () => {
    const { impl, session, locator } = await setup();
    const before = (await impl.getDataset("d1")) as TransientObject;
    const tx = await session.beginTransaction(locator);
    await session.runCommand(locator, createNote("n1"));
    await session.runCommand(locator, createNote("n2"));
    await session.prepareTransaction(locator, tx);
    await session.rollbackTransaction(locator, tx);
    const after = (await impl.getDataset("d1")) as TransientObject;
    expect(after.data_minor_version).toBe(before.data_minor_version);
    expect(after.updated_at).toBe(before.updated_at);
  });

  it("invalidate's rollback restores the versions too", async () => {
    const { impl, session, locator } = await setup();
    const before = (await impl.getDataset("d1")) as TransientObject;
    await session.beginTransaction(locator);
    await session.runCommand(locator, createNote("n1"));
    session.invalidate(locator);
    await session.queryDataset(locator);
    const after = (await impl.getDataset("d1")) as TransientObject;
    expect(after.data_minor_version).toBe(before.data_minor_version);
  });

  it("prepare is refused below the outermost level", async () => {
    const { session, locator } = await setup();
    const tx = await session.beginTransaction(locator);
    await session.beginTransaction(locator);
    await expectCode(() => session.prepareTransaction(locator, tx), "transaction_not_outermost");
    await session.commitTransaction(locator, tx);
    await session.prepareTransaction(locator, tx);
    await session.commitTransaction(locator, tx);
  });

  it("prepare checks the open transaction like commit does", async () => {
    const { session, locator } = await setup();
    await expectCode(() => session.prepareTransaction(locator, "tx_none"), "no_transaction_in_progress");
    await session.beginTransaction(locator);
    await expectCode(() => session.prepareTransaction(locator, "tx_other"), "transaction_id_mismatch");
  });

  it("prepare throws transactions_not_supported on a non-transactional format", async () => {
    const { session, locator } = await setup(false);
    await expectCode(() => session.prepareTransaction(locator, "tx1"), "transactions_not_supported");
  });

  it("prepare resolves to the versions the dataset has once the commit has run", async () => {
    const { impl, session, locator } = await setup();
    const tx = await session.beginTransaction(locator);
    await session.runCommand(locator, createNote("n1"));
    const prepared = await session.prepareTransaction(locator, tx);
    expect(prepared.changed).toBe(true);
    expect(prepared.versions).toEqual({ model_major_version: 0, model_minor_version: 0, data_major_version: 0, data_minor_version: 1 });
    await session.commitTransaction(locator, tx);
    const info = (await impl.getDataset("d1")) as TransientObject;
    expect(info.data_minor_version).toBe(prepared.versions.data_minor_version);
  });

  it("an outermost commit without prepare runs both phases", async () => {
    const { session, locator } = await setup();
    const tx = await session.beginTransaction(locator);
    await session.runCommand(locator, createNote("n1"));
    await session.commitTransaction(locator, tx);
    await expectCode(() => session.prepareTransaction(locator, tx), "no_transaction_in_progress");
  });
});

describe("ApiSession session queue", () => {
  it("queryDataset waits for an operation still pending on the same locator", async () => {
    const { session, locator } = await setup();
    const pendingCommand = session.runCommand(locator, createNote("n1"));
    const dataset = (await session.queryDataset(locator)) as TransientObject;
    await pendingCommand;
    expect(dataset.data_minor_version).toBe(1);
  });

  it("dumpDataset waits for an operation still pending on the same locator", async () => {
    const { session, locator } = await setup();
    const pendingCommand = session.runCommand(locator, createNote("n1"));
    const dump = await session.dumpDataset(locator, "json");
    await pendingCommand;
    expect(JSON.parse(dump).data.note.n1).toBeDefined();
  });

  it("a failed operation does not stop the queue", async () => {
    const { session, locator } = await setup();
    const failing = session.runCommand(locator, { kind: "create", schema: "missing_schema", input: [{ name: "x" }] });
    const next = session.queryDataset(locator);
    await expect(failing).rejects.toBeInstanceOf(ModelError);
    expect(await next).not.toBeNull();
  });

  it("queryDataset answers null for a missing dataset", async () => {
    const impl = fakeFormat(true);
    registerPersistentFormat(impl);
    const session = createApiSession();
    expect(await session.queryDataset(`${impl.name}:none`)).toBeNull();
  });

  it("deleteDataset rolls back the open transaction, deletes and leaves no transaction behind", async () => {
    const { impl, session, locator } = await setup();
    const tx1 = await session.beginTransaction(locator);
    await session.runCommand(locator, createNote("n1"));
    await session.commitTransaction(locator, tx1);
    const tx2 = await session.beginTransaction(locator);
    await session.runCommand(locator, createNote("n2"));

    const before = (await session.deleteDataset(locator)) as TransientObject;
    expect(before.name).toBe("Test");
    expect(await impl.datasetExists("d1")).toBe(false);
    await expectCode(() => session.rollbackTransaction(locator, tx2), "dataset_not_found");
  });

  it("deleteDataset throws dataset_not_found for a missing dataset", async () => {
    const impl = fakeFormat(true);
    registerPersistentFormat(impl);
    const session = createApiSession();
    await expectCode(() => session.deleteDataset(`${impl.name}:none`), "dataset_not_found");
  });
});
