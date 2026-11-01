import { describe, expect, it } from "vitest";
import { modelError } from "../src/errors.js";
import { createApiSession, registerPersistentFormat } from "../src/index.js";
import { processSchemaDescription } from "../src/schemaProcessing.js";
import type { TypeResolutionContext } from "../src/schemaProcessing.js";
import type { AuthoredCommand, Key, NormalizedSchema, PersistenceInterface, TransientObject, TransientValue } from "../src/types.js";

/**
 * Tests for the version check of an ApiSession's cached model — the Cache
 * bullet of `docs/sessions.md`.
 *
 * `fakeFormat` is an in-memory PersistenceInterface that counts the calls to
 * `listInstances(rest, "schema", ...)`, one per `loadResolvers`, so the count
 * tells how many times a locator's model was loaded. `changeModelElsewhere`
 * plays another session or process: it writes a schema straight into the
 * store and moves the model version, without going through the session under
 * test.
 */

let formatCounter = 0;

function fakeFormat(): { impl: PersistenceInterface; schemaLoads: () => number } {
  const name = `test-reval-fmt-${++formatCounter}`;
  const datasets = new Map<string, { info: TransientObject; stores: Map<string, Map<Key, TransientValue>> }>();
  let schemaLoadCount = 0;

  function getState(rest: string) {
    const state = datasets.get(rest);
    if (!state) throw modelError("dataset_not_found", `no "${name}" dataset at "${rest}"`);
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
      if (schema === "schema") schemaLoadCount += 1;
      return [...getStore(rest, schema).values()];
    },
    async putInstance(rest, schema, key, instance) {
      getStore(rest, schema).set(key, instance);
    },
    async deleteInstance(rest, schema, key) {
      getStore(rest, schema).delete(key);
    },
  };

  return { impl, schemaLoads: () => schemaLoadCount };
}

/** Adds a "note" schema to `rest` and moves one model version, as another session's model change would. */
async function changeModelElsewhere(impl: PersistenceInterface, rest: string, field: "model_minor_version" | "model_major_version"): Promise<void> {
  const schemas = new Map<string, NormalizedSchema>();
  const ctx: TypeResolutionContext = { resolveSchema: (n) => schemas.get(n), resolveScalarType: () => undefined };
  const note = processSchemaDescription({ name: "note", shared_by_name: true, properties: [{ name: "name", type: "identifier" }] }, ctx);
  await impl.putInstance(rest, "schema", "note", note as unknown as TransientValue, {});
  const info = (await impl.getDataset(rest)) as TransientObject;
  await impl.updateDataset(rest, { [field]: (info[field] as number) + 1 });
}

const warmUp: AuthoredCommand = { kind: "query", schema: "scalar_type" };
const createNote: AuthoredCommand = { kind: "create", schema: "note", input: { name: "n1" } };

async function setup() {
  const { impl, schemaLoads } = fakeFormat();
  registerPersistentFormat(impl);
  await impl.createDataset("d1", "Test");
  return { impl, schemaLoads, locator: `${impl.name}:d1` };
}

describe("ApiSession model revalidation", () => {
  it("sees a model change made elsewhere on the next runCommand, without invalidate", async () => {
    const { impl, locator } = await setup();
    const session = createApiSession();
    await session.runCommand(locator, warmUp);

    await changeModelElsewhere(impl, "d1", "model_minor_version");

    const result = await session.runCommand(locator, createNote);
    expect(result.after).toHaveLength(1);
  });

  it("sees a change of model_major_version", async () => {
    const { impl, locator } = await setup();
    const session = createApiSession();
    await session.runCommand(locator, warmUp);

    await changeModelElsewhere(impl, "d1", "model_major_version");

    expect((await session.runCommand(locator, createNote)).after).toHaveLength(1);
  });

  it("sees it on the next runScript", async () => {
    const { impl, locator } = await setup();
    const session = createApiSession();
    await session.runCommand(locator, warmUp);

    await changeModelElsewhere(impl, "d1", "model_minor_version");

    await expect(session.runScript(locator, { commands: [createNote] })).resolves.toBeDefined();
  });

  it("sees it on the next run of a ScriptSession already open", async () => {
    const { impl, locator } = await setup();
    const session = createApiSession();
    const scriptSession = await session.createScriptSession(locator);
    await scriptSession.run(warmUp);

    await changeModelElsewhere(impl, "d1", "model_minor_version");

    expect((await scriptSession.run(createNote)).after).toHaveLength(1);
  });

  it("does not reload the model while the model versions are unchanged", async () => {
    const { impl, schemaLoads, locator } = await setup();
    const session = createApiSession();

    await session.runCommand(locator, warmUp);
    await impl.updateDataset("d1", { data_minor_version: 7 });
    await session.runCommand(locator, warmUp);
    await session.runScript(locator, { commands: [warmUp] });
    await (await session.createScriptSession(locator)).run(warmUp);

    expect(schemaLoads()).toBe(1);
  });

  it("reloads once per model change, not once per call", async () => {
    const { impl, schemaLoads, locator } = await setup();
    const session = createApiSession();
    await session.runCommand(locator, warmUp);

    await changeModelElsewhere(impl, "d1", "model_minor_version");
    await session.runCommand(locator, warmUp);
    await session.runCommand(locator, warmUp);

    expect(schemaLoads()).toBe(2);
  });

  it("keeps invalidate working", async () => {
    const { schemaLoads, locator } = await setup();
    const session = createApiSession();
    await session.runCommand(locator, warmUp);

    session.invalidate(locator);
    await session.runCommand(locator, warmUp);

    expect(schemaLoads()).toBe(2);
  });

  it("revalidates each locator on its own", async () => {
    const { impl, schemaLoads, locator } = await setup();
    await impl.createDataset("d2", "Other");
    const other = `${impl.name}:d2`;
    const session = createApiSession();
    await session.runCommand(locator, warmUp);
    await session.runCommand(other, warmUp);

    await changeModelElsewhere(impl, "d1", "model_minor_version");
    await session.runCommand(locator, warmUp);
    await session.runCommand(other, warmUp);

    expect(schemaLoads()).toBe(3);
  });
});
