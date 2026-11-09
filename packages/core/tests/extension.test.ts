import { describe, expect, it } from "vitest";
import { checkUpgrade, createUpgradeLocator, registerPersistentFormat, runCommand, upgradeDataset } from "../src/testing.js";
import { runSchemaCommand } from "../src/modelUpgrade.js";
import { loadResolvers } from "../src/resolvers.js";
import { processSchemaDescription } from "../src/schemaProcessing.js";
import type { TypeResolutionContext } from "../src/schemaProcessing.js";
import type { NormalizedSchema, PersistenceInterface, TransientObject, TransientValue } from "../src/types.js";
import { expectCode, fakeFormat } from "./mapTestSupport.js";

/**
 * The `extension` relation constraint — parts `relations` (*Extensions*),
 * `property_constraints`, `schema_processing` (*Extensions*), `command`
 * (*Extensions*), `filter` and `model_upgrade` of the document `model` in the
 * `core` dataset.
 *
 * Declaration tests call schema processing directly. Model tests run schema
 * commands through `runSchemaCommand`; data tests run the public API against a
 * small in-memory transactional format. The model is a shared `task` schema
 * and its extension `task_billing`, whose properties `rate`, `currency` and
 * `labels` are seen on `task`.
 */

const TASK: TransientObject = {
  name: "task",
  shared_by_name: true,
  properties: [
    { name: "name", type: "identifier" },
    { name: "title", type: "string" },
  ],
};

const BILLING: TransientObject = {
  name: "task_billing",
  properties: [
    { name: "task", type: "task", extension: true },
    { name: "rate", type: "integer", default_value: 10 },
    { name: "currency", type: "string", enum: ["EUR", "USD"], default_value: "EUR" },
    { name: "labels", type: "string", is_array: true },
  ],
};

const SUBTASK: TransientObject = { name: "subtask", extends: "task" };

/** An extension schema of `task` named `task_billing`, holding `properties` after its `extension` relation. */
const extensionOf = (properties: TransientObject[], more: TransientObject = {}): TransientObject => ({
  name: "task_billing",
  ...more,
  properties: [{ name: "task", type: "task", extension: true }, ...properties],
});

/** A resolution context where `task`, the target of the extension schemas, and the given schemas resolve. */
function ctxWith(schemas: Record<string, NormalizedSchema> = {}): TypeResolutionContext {
  const task = processSchemaDescription(TASK, { resolveSchema: () => undefined, resolveScalarType: () => undefined });
  const all: Record<string, NormalizedSchema> = { task, ...schemas };
  return { resolveSchema: (name) => all[name], resolveScalarType: () => undefined };
}

// ---------------------------------------------------------------------------
// Declaration — schema processing of the extension schema alone
// ---------------------------------------------------------------------------

describe("extension — declaration", () => {
  it("makes the extension relation mandatory and owner", () => {
    const schema = processSchemaDescription(BILLING, ctxWith());
    const relation = schema.properties.find((p) => p.name === "task");
    expect(relation?.constraints).toMatchObject({ extension: true, mandatory: true, owner: true });
  });

  it("accepts an optional relation, an array and a scalar with a default as other properties", () => {
    const schema = processSchemaDescription(
      extensionOf([
        { name: "reviewer", type: "task" },
        { name: "labels", type: "string", is_array: true },
        { name: "rate", type: "integer", default_value: 5 },
      ]),
      ctxWith(),
    );
    expect(schema.properties.map((p) => p.name)).toEqual(["task", "reviewer", "labels", "rate"]);
  });

  const breaches: [string, TransientObject][] = [
    ["a second extension relation", extensionOf([{ name: "other", type: "task", extension: true }])],
    ["an extension on a scalar property", { name: "task_billing", properties: [{ name: "task", type: "string", extension: true }] }],
    ["an extension relation that is an array", { name: "task_billing", properties: [{ name: "task", type: "task", extension: true, is_array: true }] }],
    ["an inverse_name on the extension relation", { name: "task_billing", properties: [{ name: "task", type: "task", extension: true, inverse_name: "billings" }] }],
    ["an inverse_is_array on the extension relation", { name: "task_billing", properties: [{ name: "task", type: "task", extension: true, inverse_is_array: true }] }],
    ["another owner relation", extensionOf([{ name: "boss", type: "task", owner: true }])],
    ["a name property", extensionOf([{ name: "name", type: "identifier" }])],
    ["shared_by_name", extensionOf([], { shared_by_name: true })],
    ["is_root", extensionOf([], { is_root: true })],
    ["embedded", extensionOf([], { embedded: true })],
    ["a scalar without default value", extensionOf([{ name: "rate", type: "integer" }])],
    ["a mandatory relation besides the extension", extensionOf([{ name: "boss", type: "task", mandatory: true }])],
    ["an inverse_name on another relation", extensionOf([{ name: "boss", type: "task", inverse_name: "bossed" }])],
  ];

  it.each(breaches)("refuses %s with constraint_violation", async (_what, description) => {
    await expectCode(() => processSchemaDescription(description, ctxWith()), "constraint_violation");
  });

  it("refuses a schema extending an extension schema with constraint_violation", async () => {
    const billing = processSchemaDescription(BILLING, ctxWith());
    await expectCode(() => processSchemaDescription({ name: "special_billing", extends: "task_billing" }, ctxWith({ task_billing: billing })), "constraint_violation");
  });
});

// ---------------------------------------------------------------------------
// Model — properties generated on the target and on the schemas extending it
// ---------------------------------------------------------------------------

async function setupModel(schemas: TransientObject[]) {
  const impl = fakeFormat();
  registerPersistentFormat(impl);
  await impl.createDataset("d1", "Test");
  const resolvers = await loadResolvers(impl, "d1");
  if (schemas.length > 0) await runSchemaCommand(impl, "d1", { kind: "create", schema: "schema", input: schemas }, resolvers);
  return { impl, resolvers, locator: `${impl.name}:d1` };
}

const createSchemas = (setup: Awaited<ReturnType<typeof setupModel>>, ...input: TransientObject[]) =>
  runSchemaCommand(setup.impl, "d1", { kind: "create", schema: "schema", input }, setup.resolvers);

const propertyNames = (setup: Awaited<ReturnType<typeof setupModel>>, schema: string) =>
  (setup.resolvers.schemas.get(schema) as NormalizedSchema).properties.map((p) => p.name);

describe("extension — model", () => {
  it("generates the properties of the extension on the target, tagged with the extension, and stores them", async () => {
    const setup = await setupModel([TASK, BILLING]);
    const task = setup.resolvers.schemas.get("task") as NormalizedSchema;
    expect(task.properties.map((p) => p.name)).toEqual(["name", "title", "rate", "currency", "labels"]);
    expect(task.properties.find((p) => p.name === "rate")).toMatchObject({ type: "integer", constraints: { __extension: "task_billing" } });
    expect(task.properties.find((p) => p.name === "currency")?.constraints).toMatchObject({ enum: ["EUR", "USD"], __extension: "task_billing" });
    const stored = (await setup.impl.getInstance("d1", "schema", "task", {})) as unknown as NormalizedSchema;
    expect(stored.properties.map((p) => p.name)).toContain("rate");
    expect(propertyNames(setup, "task_billing")).toEqual(["task", "rate", "currency", "labels"]);
  });

  it("generates them on a schema extending the target, created before or after the extension", async () => {
    const before = await setupModel([TASK, SUBTASK, BILLING]);
    expect(propertyNames(before, "subtask")).toEqual(expect.arrayContaining(["rate", "currency", "labels"]));
    const after = await setupModel([TASK, BILLING]);
    await createSchemas(after, SUBTASK);
    expect(propertyNames(after, "subtask")).toEqual(expect.arrayContaining(["rate", "currency", "labels"]));
  });

  it("generates the properties of two extensions of the same target", async () => {
    const setup = await setupModel([TASK, BILLING]);
    await createSchemas(setup, { name: "task_review", properties: [{ name: "task", type: "task", extension: true }, { name: "score", type: "integer", default_value: 0 }] });
    expect(propertyNames(setup, "task")).toEqual(expect.arrayContaining(["rate", "score"]));
  });

  it("refuses an extension property named like a property of the target", async () => {
    await expectCode(() => setupModel([TASK, extensionOf([{ name: "title", type: "string", default_value: "" }])]), "constraint_violation");
  });

  it("refuses an extension property named like one of another extension of the target", async () => {
    const setup = await setupModel([TASK, BILLING]);
    await expectCode(
      () => createSchemas(setup, { name: "task_review", properties: [{ name: "task", type: "task", extension: true }, { name: "rate", type: "integer", default_value: 0 }] }),
      "constraint_violation",
    );
  });

  it("refuses a schema extending the target that declares a property of the extension, in the same command or after it", async () => {
    await expectCode(() => setupModel([TASK, BILLING, { name: "subtask", extends: "task", properties: [{ name: "rate", type: "integer" }] }]), "constraint_violation");
    const setup = await setupModel([TASK, BILLING]);
    await expectCode(() => createSchemas(setup, { name: "subtask", extends: "task", properties: [{ name: "rate", type: "integer" }] }), "constraint_violation");
  });

  it("refuses an update of the target that declares a property of the extension", async () => {
    const setup = await setupModel([TASK, BILLING]);
    await expectCode(
      () =>
        runSchemaCommand(
          setup.impl,
          "d1",
          { kind: "update", schema: "schema", filters: { name: "task" }, input: [{ ...TASK, properties: [...(TASK.properties as TransientValue[]), { name: "rate", type: "integer" }] }] },
          setup.resolvers,
        ),
      "constraint_violation",
    );
  });

  it("keeps the generated properties when the target is updated", async () => {
    const setup = await setupModel([TASK, BILLING]);
    await runSchemaCommand(
      setup.impl,
      "d1",
      { kind: "update", schema: "schema", filters: { name: "task" }, input: [{ ...TASK, properties: [...(TASK.properties as TransientValue[]), { name: "due", type: "string" }] }] },
      setup.resolvers,
    );
    expect(propertyNames(setup, "task")).toEqual(expect.arrayContaining(["due", "rate", "currency", "labels"]));
  });

  it("regenerates the properties when the extension is updated", async () => {
    const setup = await setupModel([TASK, BILLING]);
    await runSchemaCommand(
      setup.impl,
      "d1",
      { kind: "update", schema: "schema", filters: { name: "task_billing" }, input: [extensionOf([{ name: "notes", type: "string", default_value: "" }])] },
      setup.resolvers,
    );
    const names = propertyNames(setup, "task");
    expect(names).toContain("notes");
    expect(names).not.toContain("rate");
  });

  it("removes the generated properties when the extension is deleted", async () => {
    const setup = await setupModel([TASK, SUBTASK, BILLING]);
    await runSchemaCommand(setup.impl, "d1", { kind: "delete", schema: "schema", filters: { name: "task_billing" } }, setup.resolvers);
    expect(propertyNames(setup, "task")).toEqual(["name", "title"]);
    expect(propertyNames(setup, "subtask")).toEqual(["name", "title"]);
  });

  it("refuses a relation that targets the extension schema, in the same command or after it", async () => {
    const invoice = { name: "invoice", properties: [{ name: "billing", type: "task_billing" }] };
    await expectCode(() => setupModel([TASK, BILLING, invoice]), "constraint_violation");
    const setup = await setupModel([TASK, BILLING]);
    await expectCode(() => createSchemas(setup, invoice), "constraint_violation");
  });

  it("refuses an extension of an extension schema", async () => {
    await expectCode(() => setupModel([TASK, BILLING, { name: "billing_note", properties: [{ name: "billing", type: "task_billing", extension: true }] }]), "constraint_violation");
  });

  it("refuses an extension whose target is unknown with unknown_extends_target", async () => {
    await expectCode(() => setupModel([{ name: "orphan", properties: [{ name: "task", type: "nowhere", extension: true }] }]), "unknown_extends_target");
  });
});

// ---------------------------------------------------------------------------
// Data — the properties of the extension are seen on the target
// ---------------------------------------------------------------------------

const createTask = (locator: string, ...items: TransientObject[]) => runCommand(locator, { kind: "create", schema: "task", input: items });
const queryTasks = (locator: string, filters: TransientObject = {}) => runCommand(locator, { kind: "query", schema: "task", filters });
const updateTask = (locator: string, name: string, patch: TransientObject) =>
  runCommand(locator, { kind: "update", schema: "task", filters: { name }, input: [patch] });
const deleteTask = (locator: string, name: string) => runCommand(locator, { kind: "delete", schema: "task", filters: { name } });
const names = (result: { after: TransientValue[] }) => result.after.map((i) => (i as TransientObject).name).sort();
const stored = (impl: PersistenceInterface, schema: string, key: string) => impl.getInstance("d1", schema, key, {});

describe("extension — create", () => {
  it("creates the extension instance with the defaults, under the key of the task, and returns its properties on the task", async () => {
    const { impl, locator } = await setupModel([TASK, BILLING]);
    const result = await createTask(locator, { name: "t1", title: "A" });
    expect(result.after[0]).toMatchObject({ name: "t1", title: "A", rate: 10, currency: "EUR", labels: [] });
    expect(await stored(impl, "task_billing", "t1")).toMatchObject({ id: "t1", task: "t1", rate: 10, currency: "EUR", labels: [] });
  });

  it("keeps the properties of the extension out of the stored task", async () => {
    const { impl, locator } = await setupModel([TASK, BILLING]);
    await createTask(locator, { name: "t1", title: "A", rate: 25 });
    const raw = (await stored(impl, "task", "t1")) as TransientObject;
    expect(raw).toMatchObject({ name: "t1", title: "A" });
    expect(raw).not.toHaveProperty("rate");
    expect(raw).not.toHaveProperty("currency");
  });

  it("takes the values the input gives for the properties of the extension", async () => {
    const { impl, locator } = await setupModel([TASK, BILLING]);
    await createTask(locator, { name: "t1", rate: 25, currency: "USD", labels: ["x", "y"] });
    expect(await stored(impl, "task_billing", "t1")).toMatchObject({ rate: 25, currency: "USD", labels: ["x", "y"] });
    expect(names(await queryTasks(locator, { rate: 25 }))).toEqual(["t1"]);
  });

  it("validates the properties of the extension and stores nothing on a violation", async () => {
    const { impl, locator } = await setupModel([TASK, BILLING]);
    await expectCode(() => createTask(locator, { name: "t1", currency: "XXX" }), "constraint_violation");
    expect(await stored(impl, "task", "t1")).toBeNull();
    expect(await stored(impl, "task_billing", "t1")).toBeNull();
  });

  it("creates the instances of every extension of the task", async () => {
    const { impl, locator } = await setupModel([TASK, BILLING, { name: "task_review", properties: [{ name: "task", type: "task", extension: true }, { name: "score", type: "integer", default_value: 3 }] }]);
    const result = await createTask(locator, { name: "t1" });
    expect(result.after[0]).toMatchObject({ rate: 10, score: 3 });
    expect(await stored(impl, "task_review", "t1")).toMatchObject({ task: "t1", score: 3 });
  });

  it("creates the extension instance of a schema extending the task", async () => {
    const { impl, locator } = await setupModel([TASK, SUBTASK, BILLING]);
    const result = await runCommand(locator, { kind: "create", schema: "subtask", input: [{ name: "s1", rate: 7 }] });
    expect(result.after[0]).toMatchObject({ name: "s1", rate: 7 });
    expect(await stored(impl, "task_billing", "s1")).toMatchObject({ task: "s1", rate: 7 });
    expect(names(await queryTasks(locator, { rate: 7 }))).toEqual(["s1"]);
  });
});

describe("extension — query", () => {
  async function seeded() {
    const setup = await setupModel([TASK, BILLING, { name: "assignment", shared_by_name: true, properties: [{ name: "name", type: "identifier" }, { name: "task", type: "task" }] }]);
    await createTask(setup.locator, { name: "t1", rate: 20 }, { name: "t2" }, { name: "t3", currency: "USD", labels: ["x"] });
    await runCommand(setup.locator, {
      kind: "create",
      schema: "assignment",
      input: [
        { name: "a1", task: "t1" },
        { name: "a2", task: "t2" },
      ],
    });
    return setup;
  }

  it("returns the properties of the extension and filters on them", async () => {
    const { locator } = await seeded();
    expect(names(await queryTasks(locator, { rate: { gte: 15 } }))).toEqual(["t1"]);
    expect(names(await queryTasks(locator, { currency: "USD" }))).toEqual(["t3"]);
    expect(names(await queryTasks(locator, { labels: { contains: "x" } }))).toEqual(["t3"]);
    expect(names(await queryTasks(locator, { or: [{ rate: 20 }, { currency: "USD" }] }))).toEqual(["t1", "t3"]);
  });

  it("filters on a property of the extension across a relation", async () => {
    const { locator } = await seeded();
    const result = await runCommand(locator, { kind: "query", schema: "assignment", filters: { "task.rate": { gte: 15 } } });
    expect(names(result)).toEqual(["a1"]);
  });

  it("keeps only the requested properties of the extension in result.properties", async () => {
    const { locator } = await seeded();
    const result = await runCommand(locator, { kind: "query", schema: "task", filters: { name: "t1" }, result: { properties: ["rate"] } });
    expect(result.after[0]).toEqual({ name: "t1", rate: 20 });
  });

  it("refuses a filter on an unknown property", async () => {
    const { locator } = await seeded();
    await expectCode(() => queryTasks(locator, { missing: 1 }), "unknown_property");
  });
});

describe("extension — update and delete", () => {
  it("updates the properties of the extension through the task, in the extension instance only", async () => {
    const { impl, locator } = await setupModel([TASK, BILLING]);
    await createTask(locator, { name: "t1", title: "A" });
    const result = await updateTask(locator, "t1", { rate: 30, title: "B" });
    expect(result.before[0]).toMatchObject({ rate: 10, title: "A" });
    expect(result.after[0]).toMatchObject({ rate: 30, title: "B" });
    expect(await stored(impl, "task_billing", "t1")).toMatchObject({ rate: 30 });
    const raw = (await stored(impl, "task", "t1")) as TransientObject;
    expect(raw).toMatchObject({ title: "B" });
    expect(raw).not.toHaveProperty("rate");
  });

  it("refuses an invalid value of the extension and leaves both instances unchanged", async () => {
    const { impl, locator } = await setupModel([TASK, BILLING]);
    await createTask(locator, { name: "t1", title: "A" });
    await expectCode(() => updateTask(locator, "t1", { title: "B", currency: "XXX" }), "constraint_violation");
    expect(await stored(impl, "task_billing", "t1")).toMatchObject({ currency: "EUR" });
    expect(await stored(impl, "task", "t1")).toMatchObject({ title: "A" });
  });

  it("deletes the extension instance with the task and does not report it", async () => {
    const { impl, locator } = await setupModel([TASK, BILLING]);
    await createTask(locator, { name: "t1" });
    const result = await deleteTask(locator, "t1");
    expect(result["cascade-deleted"]).toEqual([]);
    expect(await stored(impl, "task", "t1")).toBeNull();
    expect(await stored(impl, "task_billing", "t1")).toBeNull();
  });

  it("deletes the extension instance of a schema extending the task", async () => {
    const { impl, locator } = await setupModel([TASK, SUBTASK, BILLING]);
    await runCommand(locator, { kind: "create", schema: "subtask", input: [{ name: "s1" }] });
    await deleteTask(locator, "s1");
    expect(await stored(impl, "task_billing", "s1")).toBeNull();
  });
});

describe("extension — extension schema is not addressable", () => {
  it.each([
    ["query", {}],
    ["create", { input: [{ id: "x" }] }],
    ["update", { input: [{ rate: 1 }] }],
    ["delete", {}],
  ])("refuses a %s on the extension schema with extension_not_addressable", async (kind, rest) => {
    const { locator } = await setupModel([TASK, BILLING]);
    await expectCode(() => runCommand(locator, { kind, schema: "task_billing", ...rest } as never), "extension_not_addressable");
  });
});

describe("extension — model upgrade", () => {
  it("creates the extension instance of every existing instance of the target when the extension is added", async () => {
    const { impl, locator } = await setupModel([TASK, SUBTASK]);
    await createTask(locator, { name: "t1" }, { name: "t2" });
    await runCommand(locator, { kind: "create", schema: "subtask", input: [{ name: "s1" }] });

    const upgrade = await createUpgradeLocator(locator);
    await runCommand(upgrade, { kind: "create", schema: "schema", input: [BILLING] });
    const check = await checkUpgrade(locator, upgrade);
    expect(check.modifiedSchema).toEqual([]);
    expect(check.lostSchema).toEqual([]);
    await upgradeDataset(locator, upgrade);

    expect(await stored(impl, "task_billing", "t2")).toMatchObject({ task: "t2", rate: 10, currency: "EUR" });
    expect(await stored(impl, "task_billing", "s1")).toMatchObject({ task: "s1", rate: 10 });
    expect(await stored(impl, "task", "t1")).not.toHaveProperty("rate");
    const result = await queryTasks(locator);
    expect(result.after.map((i) => (i as TransientObject).rate)).toEqual([10, 10, 10]);
  });
});
