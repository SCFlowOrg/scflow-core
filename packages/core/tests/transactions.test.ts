import { describe, expect, it } from "vitest";
import { ModelError } from "../src/errors.js";
import { createApiSession, registerPersistentFormat } from "../src/testing.js";
import type { ApiSession, Delta, PreparedTransaction } from "../src/index.js";
import { applyInverseRelations } from "../src/modelUpgrade.js";
import { processSchemaDescription } from "../src/schemaProcessing.js";
import type { TypeResolutionContext } from "../src/schemaProcessing.js";
import type { AuthoredCommand, Key, NormalizedSchema, PersistenceInterface, TransientObject, TransientValue } from "../src/types.js";

/**
 * Tests for ApiSession's transaction methods, the delta a transaction yields
 * and `revert` — `docs/sessions.md`.
 *
 * `fakeFormat` is a minimal in-memory PersistenceInterface, in the style of
 * apiSession.test.ts's own, parameterized on `supportsTransactions` (default
 * `true` — this suite is mostly about the transactional case).
 */

let formatCounter = 0;

function fakeFormat(supportsTransactions = true): PersistenceInterface {
  const name = `test-tx-fmt-${++formatCounter}`;
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
      return getState(rest).info;
    },
    async updateDataset(rest, patch) {
      const state = getState(rest);
      Object.assign(state.info, patch as object);
      return state.info;
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

/** Seeds a plain "note" schema directly into `impl`'s store, so `runCommand`/`runScript` on it needs no upgrade locator. */
async function seedNoteSchema(impl: PersistenceInterface, rest: string): Promise<void> {
  const schemas = new Map<string, NormalizedSchema>();
  const ctx: TypeResolutionContext = { resolveSchema: (n) => schemas.get(n), resolveScalarType: () => undefined };
  const note = processSchemaDescription(
    { name: "note", shared_by_name: true, properties: [{ name: "name", type: "identifier" }, { name: "title", type: "string" }] },
    ctx,
  );
  await impl.putInstance(rest, "schema", "note", note as unknown as TransientValue, {});
}

/**
 * Seeds "workspace" (parent) and "page" (child, `owner: true` pointing up at
 * workspace) directly into `impl`'s store — deleting a workspace cascades
 * deletes its pages via command.ts's `performDelete`, through the "declared
 * owner property on some other schema" scanning branch (the same mechanism
 * as the model doc's own comment/task example): no `owns`, no generated
 * inverse involved, `page.workspace` is a real, authored, single-valued
 * relation.
 */
async function seedWorkspacePageSchemas(impl: PersistenceInterface, rest: string): Promise<void> {
  const schemas = new Map<string, NormalizedSchema>();
  const ctx: TypeResolutionContext = { resolveSchema: (n) => schemas.get(n), resolveScalarType: () => undefined };
  const workspace = processSchemaDescription(
    { name: "workspace", shared_by_name: true, properties: [{ name: "name", type: "identifier" }] },
    ctx,
  );
  schemas.set("workspace", workspace);
  await impl.putInstance(rest, "schema", "workspace", workspace as unknown as TransientValue, {});
  const page = processSchemaDescription(
    {
      name: "page",
      shared_by_name: true,
      properties: [
        { name: "name", type: "identifier" },
        { name: "workspace", type: "workspace", owner: true, mandatory: true },
      ],
    },
    ctx,
  );
  schemas.set("page", page);
  await impl.putInstance(rest, "schema", "page", page as unknown as TransientValue, {});
}

/**
 * Seeds "cabinet" (owns exactly one "item", via a real, single-valued,
 * stored `prized` property — `is_array` can't be set on a directly-declared
 * relation, per packages/core/docs/spec/meta-model.md#relations's revised "always
 * single-valued" rule, so this is the only shape `owns` can take on an
 * authored property today) and "item" (gets the generated, virtual,
 * `owner: true` `cabinet` inverse via `applyInverseRelations` — the real
 * function command.ts's runSchemaCommand itself calls, not hand-rolled, same
 * as command.liveJoinCache.test.ts's own fixture). Deleting an item directly
 * (not via cabinet cascade) triggers command.ts's `detachFromOwner`, which
 * writes the item's key out of `cabinet`'s own stored `prized` field.
 */
async function seedCabinetItemSchemas(impl: PersistenceInterface, rest: string): Promise<void> {
  const schemas = new Map<string, NormalizedSchema>();
  const ctx: TypeResolutionContext = { resolveSchema: (n) => schemas.get(n), resolveScalarType: () => undefined };
  const item = processSchemaDescription({ name: "item", shared_by_name: true, properties: [{ name: "name", type: "identifier" }] }, ctx);
  schemas.set("item", item);
  await impl.putInstance(rest, "schema", "item", item as unknown as TransientValue, {});
  const cabinet = processSchemaDescription(
    {
      name: "cabinet",
      shared_by_name: true,
      properties: [
        { name: "name", type: "identifier" },
        { name: "prized", type: "item", owns: true, inverse_name: "cabinet" },
      ],
    },
    ctx,
  );
  schemas.set("cabinet", cabinet);
  await impl.putInstance(rest, "schema", "cabinet", cabinet as unknown as TransientValue, {});
  // Generates "item"'s virtual `cabinet` property (owner:true, __generated:true,
  // single-valued) and writes the updated "item" schema back into `impl`.
  await applyInverseRelations(impl, rest, schemas, cabinet);
}

const createNote = (name: string, title: string): AuthoredCommand => ({ kind: "create", schema: "note", input: [{ name, title }] });
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

async function noteSetup() {
  const impl = fakeFormat(true);
  registerPersistentFormat(impl);
  await impl.createDataset("d1", "Test");
  await seedNoteSchema(impl, "d1");
  return { impl, session: createApiSession(), locator: `${impl.name}:d1` };
}

/** Runs `work` in a transaction that is prepared, then committed; resolves to what `prepareTransaction` returned. */
async function transact(session: ApiSession, locator: string, work: () => Promise<unknown>): Promise<PreparedTransaction> {
  const tx = await session.beginTransaction(locator);
  await work();
  const prepared = await session.prepareTransaction(locator, tx);
  await session.commitTransaction(locator, tx);
  return prepared;
}

const revertInTransaction = (session: ApiSession, locator: string, delta: Delta) => transact(session, locator, () => session.revert(locator, delta));

async function noteTitles(session: ApiSession, locator: string): Promise<string[]> {
  const result = await session.runCommand(locator, queryNotes);
  return (result.after as TransientObject[]).map((n) => n.title as string);
}

async function dataMinorVersion(impl: PersistenceInterface): Promise<number> {
  return ((await impl.getDataset("d1")) as TransientObject).data_minor_version as number;
}

describe("ApiSession.supportsTransactions", () => {
  it("returns true for a format that declares it", async () => {
    const impl = fakeFormat(true);
    registerPersistentFormat(impl);
    await impl.createDataset("d1", "Test");
    const session = createApiSession();

    expect(await session.supportsTransactions(`${impl.name}:d1`)).toBe(true);
  });

  it("returns false for a format that doesn't declare it", async () => {
    const impl = fakeFormat(false);
    registerPersistentFormat(impl);
    await impl.createDataset("d1", "Test");
    const session = createApiSession();

    expect(await session.supportsTransactions(`${impl.name}:d1`)).toBe(false);
  });

  it("throws dataset_not_found for a locator with no dataset", async () => {
    const impl = fakeFormat(true);
    registerPersistentFormat(impl);
    const session = createApiSession();

    await expectCode(() => session.supportsTransactions(`${impl.name}:missing`), "dataset_not_found");
  });
});

describe("ApiSession transaction methods — capability gating", () => {
  it("beginTransaction throws transactions_not_supported on a non-transactional format", async () => {
    const impl = fakeFormat(false);
    registerPersistentFormat(impl);
    await impl.createDataset("d1", "Test");
    const session = createApiSession();

    await expectCode(() => session.beginTransaction(`${impl.name}:d1`), "transactions_not_supported");
  });

  it("prepare/commit/rollback/revert throw transactions_not_supported on a non-transactional format", async () => {
    const impl = fakeFormat(false);
    registerPersistentFormat(impl);
    await impl.createDataset("d1", "Test");
    const session = createApiSession();
    const locator = `${impl.name}:d1`;

    await expectCode(() => session.prepareTransaction(locator, "tx1"), "transactions_not_supported");
    await expectCode(() => session.commitTransaction(locator, "tx1"), "transactions_not_supported");
    await expectCode(() => session.rollbackTransaction(locator, "tx1"), "transactions_not_supported");
    await expectCode(() => session.revert(locator, {}), "transactions_not_supported");
  });

  it("the session exposes no undo, redo, canUndo, canRedo or subscribeHistory", () => {
    const session = createApiSession() as unknown as Record<string, unknown>;

    for (const removed of ["undo", "redo", "canUndo", "canRedo", "subscribeHistory"]) {
      expect(session[removed]).toBeUndefined();
    }
  });
});

describe("ApiSession.prepareTransaction — result", () => {
  it("resolves changed false and an empty delta for a transaction that changed nothing", async () => {
    const { impl, session, locator } = await noteSetup();
    const before = await dataMinorVersion(impl);

    const prepared = await transact(session, locator, () => session.runCommand(locator, queryNotes));

    expect(prepared.changed).toBe(false);
    expect(prepared.versions.data_minor_version).toBe(before);
    // Reverting an empty delta changes nothing.
    const reverted = await revertInTransaction(session, locator, prepared.delta);
    expect(reverted.changed).toBe(false);
    expect(await dataMinorVersion(impl)).toBe(before);
  });

  it("resolves changed true, a delta and the versions the dataset has after the commit", async () => {
    const { impl, session, locator } = await noteSetup();

    const prepared = await transact(session, locator, () => session.runCommand(locator, createNote("n1", "One")));

    expect(prepared.changed).toBe(true);
    expect(prepared.versions).toEqual({
      model_major_version: 0,
      model_minor_version: 0,
      data_major_version: 0,
      data_minor_version: await dataMinorVersion(impl),
    });
    expect(prepared.versions.data_minor_version).toBeGreaterThan(0);
  });

  it("a transaction made only of a create then a delete of the same instance changed nothing", async () => {
    const { session, locator } = await noteSetup();

    const prepared = await transact(session, locator, async () => {
      await session.runCommand(locator, createNote("n1", "Created and deleted"));
      await session.runCommand(locator, { kind: "delete", schema: "note", filters: { name: "n1" } });
    });

    expect(prepared.changed).toBe(false);
  });

  it("commit without prepare still finalizes", async () => {
    const { session, locator } = await noteSetup();

    const tx = await session.beginTransaction(locator);
    await session.runCommand(locator, createNote("n1", "One"));
    await session.commitTransaction(locator, tx);

    expect(await noteTitles(session, locator)).toEqual(["One"]);
  });
});

describe("Delta", () => {
  it("is immutable and survives a JSON round trip", async () => {
    const { session, locator } = await noteSetup();
    const { delta } = await transact(session, locator, () => session.runCommand(locator, createNote("n1", "One")));

    expect(Object.isFrozen(delta)).toBe(true);

    const copy = JSON.parse(JSON.stringify(delta)) as Delta;
    await revertInTransaction(session, locator, copy);
    expect(await noteTitles(session, locator)).toEqual([]);
  });

  it("is left unchanged by a revert", async () => {
    const { session, locator } = await noteSetup();
    const { delta } = await transact(session, locator, () => session.runCommand(locator, createNote("n1", "One")));
    const snapshot = JSON.stringify(delta);

    await revertInTransaction(session, locator, delta);

    expect(JSON.stringify(delta)).toBe(snapshot);
  });

  it("can be reverted through another ApiSession against the same dataset", async () => {
    const { session, locator } = await noteSetup();
    const { delta } = await transact(session, locator, () => session.runCommand(locator, createNote("n1", "One")));

    const other = createApiSession();
    await revertInTransaction(other, locator, delta);

    expect(await noteTitles(other, locator)).toEqual([]);
  });

  it("captures an instance deleted as a cascade side effect", async () => {
    const impl = fakeFormat(true);
    registerPersistentFormat(impl);
    await impl.createDataset("d1", "Test");
    await seedWorkspacePageSchemas(impl, "d1");
    const session = createApiSession();
    const locator = `${impl.name}:d1`;
    await session.runCommand(locator, { kind: "create", schema: "workspace", input: [{ name: "Workspace1" }] });
    await session.runCommand(locator, { kind: "create", schema: "page", input: [{ name: "Page1", workspace: "Workspace1" }] });

    const { delta } = await transact(session, locator, () => session.runCommand(locator, { kind: "delete", schema: "workspace", filters: { name: "Workspace1" } }));
    await revertInTransaction(session, locator, delta);

    expect((await session.runCommand(locator, { kind: "query", schema: "workspace" })).after).toHaveLength(1);
    expect((await session.runCommand(locator, { kind: "query", schema: "page" })).after).toHaveLength(1);
  });

  it("captures an owner's own field rewritten by a direct child delete", async () => {
    const impl = fakeFormat(true);
    registerPersistentFormat(impl);
    await impl.createDataset("d1", "Test");
    await seedCabinetItemSchemas(impl, "d1");
    const session = createApiSession();
    const locator = `${impl.name}:d1`;
    await session.runCommand(locator, { kind: "create", schema: "cabinet", input: [{ name: "Cabinet1" }] });
    await session.runCommand(locator, { kind: "create", schema: "item", input: [{ name: "Item1", cabinet: "Cabinet1" }] });

    const { delta } = await transact(session, locator, () => session.runCommand(locator, { kind: "delete", schema: "item", filters: { name: "Item1" } }));
    await revertInTransaction(session, locator, delta);

    expect((await session.runCommand(locator, { kind: "query", schema: "item" })).after).toHaveLength(1);
    const cabinet1 = ((await session.runCommand(locator, { kind: "query", schema: "cabinet" })).after as TransientObject[])[0];
    expect(cabinet1.prized).toBe("Item1");
  });

  it("captures every command of a runScript chain", async () => {
    const { session, locator } = await noteSetup();

    const { delta } = await transact(session, locator, () =>
      session.runScript(locator, { commands: [createNote("n1", "First"), createNote("n2", "Second"), createNote("n3", "Third")] }),
    );
    await revertInTransaction(session, locator, delta);

    expect(await noteTitles(session, locator)).toEqual([]);
  });
});

describe("ApiSession.revert", () => {
  it("reverts a create, an update and a delete", async () => {
    const { session, locator } = await noteSetup();
    await session.runCommand(locator, createNote("n1", "One"));
    await session.runCommand(locator, createNote("n2", "Two"));

    const created = await transact(session, locator, () => session.runCommand(locator, createNote("n3", "Three")));
    await revertInTransaction(session, locator, created.delta);
    expect(await noteTitles(session, locator)).toEqual(["One", "Two"]);

    const updated = await transact(session, locator, () => session.runCommand(locator, { kind: "update", schema: "note", filters: { name: "n1" }, input: { title: "Changed" } }));
    await revertInTransaction(session, locator, updated.delta);
    expect(await noteTitles(session, locator)).toEqual(["One", "Two"]);

    const deleted = await transact(session, locator, () => session.runCommand(locator, { kind: "delete", schema: "note", filters: { name: "n2" } }));
    await revertInTransaction(session, locator, deleted.delta);
    expect(await noteTitles(session, locator)).toEqual(["One", "Two"]);
  });

  it("moves the versions forward, bumping the minor data version once", async () => {
    const { impl, session, locator } = await noteSetup();
    const { delta } = await transact(session, locator, () => session.runCommand(locator, createNote("n1", "One")));
    const before = await dataMinorVersion(impl);

    await revertInTransaction(session, locator, delta);

    expect(await dataMinorVersion(impl)).toBe(before + 1);
  });

  it("a transaction made of revert(d) yields the inverse of d, which reverts back", async () => {
    const { impl, session, locator } = await noteSetup();
    const created = await transact(session, locator, () => session.runCommand(locator, createNote("n1", "One")));

    const inverse = await revertInTransaction(session, locator, created.delta);
    expect(inverse.changed).toBe(true);
    expect(inverse.versions.data_minor_version).toBe(await dataMinorVersion(impl));
    expect(await noteTitles(session, locator)).toEqual([]);

    await revertInTransaction(session, locator, inverse.delta);
    expect(await noteTitles(session, locator)).toEqual(["One"]);
  });

  it("throws stale_delta when the same delta is reverted twice", async () => {
    const { session, locator } = await noteSetup();
    const { delta } = await transact(session, locator, () => session.runCommand(locator, createNote("n1", "One")));
    await revertInTransaction(session, locator, delta);

    const tx = await session.beginTransaction(locator);
    await expectCode(() => session.revert(locator, delta), "stale_delta");
    await session.rollbackTransaction(locator, tx);
  });

  it("throws stale_delta, writing nothing, after a change committed in between", async () => {
    const { session, locator } = await noteSetup();
    const { delta } = await transact(session, locator, () => session.runCommand(locator, createNote("n1", "One")));
    await session.runCommand(locator, createNote("n2", "Two"));

    const tx = await session.beginTransaction(locator);
    await expectCode(() => session.revert(locator, delta), "stale_delta");
    await session.rollbackTransaction(locator, tx);

    expect(await noteTitles(session, locator)).toEqual(["One", "Two"]);
  });

  it("throws stale_delta after a model version change", async () => {
    const { impl, session, locator } = await noteSetup();
    const { delta } = await transact(session, locator, () => session.runCommand(locator, createNote("n1", "One")));
    await impl.updateDataset("d1", { model_minor_version: 5 });

    const tx = await session.beginTransaction(locator);
    await expectCode(() => session.revert(locator, delta), "stale_delta");
    await session.rollbackTransaction(locator, tx);
  });

  it("throws stale_delta after a change made earlier in the same transaction", async () => {
    const { session, locator } = await noteSetup();
    const { delta } = await transact(session, locator, () => session.runCommand(locator, createNote("n1", "One")));

    const tx = await session.beginTransaction(locator);
    await session.runCommand(locator, createNote("n2", "Two"));
    await expectCode(() => session.revert(locator, delta), "stale_delta");
    await session.rollbackTransaction(locator, tx);
  });

  it("throws invalid_delta for a value that is not a delta", async () => {
    const { session, locator } = await noteSetup();

    const tx = await session.beginTransaction(locator);
    await expectCode(() => session.revert(locator, "nope"), "invalid_delta");
    await expectCode(() => session.revert(locator, { format: 99, versions: {}, entries: [] }), "invalid_delta");
    await session.rollbackTransaction(locator, tx);
  });

  it("throws no_transaction_in_progress outside a transaction", async () => {
    const { session, locator } = await noteSetup();
    const { delta } = await transact(session, locator, () => session.runCommand(locator, createNote("n1", "One")));

    await expectCode(() => session.revert(locator, delta), "no_transaction_in_progress");
  });

  it("throws transaction_prepared on a prepared transaction", async () => {
    const { session, locator } = await noteSetup();
    const { delta } = await transact(session, locator, () => session.runCommand(locator, createNote("n1", "One")));

    const tx = await session.beginTransaction(locator);
    await session.prepareTransaction(locator, tx);
    await expectCode(() => session.revert(locator, delta), "transaction_prepared");
    await session.rollbackTransaction(locator, tx);
  });

  it("a rollback of a transaction containing a revert restores the data and the versions", async () => {
    const { impl, session, locator } = await noteSetup();
    const { delta } = await transact(session, locator, () => session.runCommand(locator, createNote("n1", "One")));
    const before = await dataMinorVersion(impl);

    const tx = await session.beginTransaction(locator);
    await session.revert(locator, delta);
    expect(await noteTitles(session, locator)).toEqual([]);
    await session.rollbackTransaction(locator, tx);

    expect(await noteTitles(session, locator)).toEqual(["One"]);
    expect(await dataMinorVersion(impl)).toBe(before);
  });
});

describe("ApiSession transactions — nesting, rollback, invalidate", () => {
  it("nested beginTransaction returns the same transactionId, and only the outermost commit finalizes", async () => {
    const { session, locator } = await noteSetup();

    const outer = await session.beginTransaction(locator);
    const inner = await session.beginTransaction(locator);
    expect(inner).toBe(outer);

    await session.runCommand(locator, createNote("n1", "One"));
    await expectCode(() => session.prepareTransaction(locator, outer), "transaction_not_outermost");
    await session.commitTransaction(locator, inner); // depth 2 -> 1, not yet finalized

    const prepared = await session.prepareTransaction(locator, outer);
    expect(prepared.changed).toBe(true);
    await session.commitTransaction(locator, outer);
  });

  it("commit with a transactionId that isn't the currently open one throws transaction_id_mismatch", async () => {
    const { session, locator } = await noteSetup();
    await session.beginTransaction(locator);

    await expectCode(() => session.commitTransaction(locator, "not-the-open-one"), "transaction_id_mismatch");
  });

  it("commit and rollback with no open transaction throw no_transaction_in_progress", async () => {
    const { session, locator } = await noteSetup();

    await expectCode(() => session.commitTransaction(locator, "whatever"), "no_transaction_in_progress");
    await expectCode(() => session.rollbackTransaction(locator, "whatever"), "no_transaction_in_progress");
  });

  it("rollback at any depth discards everything since the outermost begin and invalidates every id for it", async () => {
    const { session, locator } = await noteSetup();

    const outer = await session.beginTransaction(locator);
    await session.runCommand(locator, createNote("n1", "One"));
    const inner = await session.beginTransaction(locator);
    await session.runCommand(locator, createNote("n2", "Two"));

    await session.rollbackTransaction(locator, inner);

    expect(await noteTitles(session, locator)).toEqual([]);
    await expectCode(() => session.commitTransaction(locator, outer), "no_transaction_in_progress");
  });

  it("invalidate rolls back the locator's open transaction", async () => {
    const { session, locator } = await noteSetup();
    await session.runCommand(locator, createNote("n1", "One"));

    const tx = await session.beginTransaction(locator);
    await session.runCommand(locator, createNote("n2", "Two"));

    session.invalidate(locator);

    await expectCode(() => session.commitTransaction(locator, tx), "no_transaction_in_progress");
    expect(await noteTitles(session, locator)).toEqual(["One"]);
  });
});
