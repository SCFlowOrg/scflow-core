import { describe, expect, it } from "vitest";
import {
  bumpMajorVersions,
  createApiSession,
  createModuleSet,
  checkUpgrade,
  createUpgradeLocator,
  MCL_CORE,
  deleteDataset,
  dumpDataset,
  initDataset,
  NO_ROLES,
  processScalarTypeDescription,
  processSchemaDescription,
  queryDataset,
  queryUpgradeLocator,
  readModuleManifest,
  registerPersistentFormat,
  restoreDataset,
  runCommand,
  runScript,
  upgradeDataset,
} from "@scfloworg/core";
import type { NormalizedSchema, PersistenceInterface, TransientValue } from "@scfloworg/core";
import { datasetModuleCases } from "./datasetModules.js";
import { facetCases } from "./facets.js";
import { moduleUpgradeCases } from "./moduleUpgrade.js";

/**
 * A format-agnostic vitest suite, derived from packages/core/docs/spec/model-command-language.md#examples's
 * worked examples: the same "tasks-demo" model (person / task_status / task / comment),
 * run end to end through create / query / update / delete / script.
 *
 * Any PersistenceInterface implementation can prove it supports the command language
 * correctly by calling `runConformanceSuite(myImpl, "my-format-prefix")` from its own
 * test file — see packages/format-js/tests/format-js.test.ts.
 *
 * Assertions use `toMatchObject` and dynamically-captured ids/keys rather than exact
 * equality against the doc's illustrative `t1`/`c1` ids, since the spec doesn't mandate
 * any particular id shape (see @scfloworg/format-js's README) and a virtual inverse-relation
 * property (e.g. `comments: []` on a fresh task) legitimately shows up on instances the
 * doc's trimmed-for-readability examples don't display.
 */
let counter = 0;

export function runConformanceSuite(impl: PersistenceInterface, formatPrefix: string): void {
  registerPersistentFormat(impl);

  function newLocator(): string {
    counter += 1;
    return `${formatPrefix}:conformance-${Date.now()}-${counter}`;
  }

  /**
   * Builds the model through a single upgrade locator, per
   * `docs/model-upgrade.md` of `@scfloworg/core` — `schema`/
   * `scalar_type` are no longer added directly (addSchema/addScalarType are
   * gone); each is `create`d via `runCommand` against an upgrade locator, in
   * the same dependency order the old direct calls required (a schema
   * referencing another schema or a custom scalar type must come after the
   * thing it references — resolvers reload on every call against the same
   * locator, so each step already sees every earlier one), then applied in
   * one `upgradeDataset` call. There's no existing data yet, so every change
   * here is trivially compatible.
   */
  async function setupTaskDemo(locator: string): Promise<void> {
    await initDataset(locator, "tasks-demo");
    const upgradeLocator = await createUpgradeLocator(locator);
    await runCommand(upgradeLocator, {
      create: "schema",
      input: [
        {
          name: "person",
          shared_by_name: null,
          properties: [
            { name: "name", type: "identifier" },
            { name: "email", type: "email" },
          ],
        },
      ],
    });
    await runCommand(upgradeLocator, {
      create: "scalar_type",
      input: [{ name: "task_status", extends: "string", enum: ["open", "in_progress", "done"] }],
    });
    await runCommand(upgradeLocator, {
      create: "schema",
      input: [
        {
          name: "task",
          is_root: null,
          properties: [
            { name: "title", type: "string" },
            { name: "status", type: "task_status", default_value: "open" },
            { name: "priority", type: "integer", default_value: "0" },
            { name: "assignee", type: "person", inverse_name: "assigned_tasks", inverse_is_array: null },
            { name: "tags", type: "[string]" },
          ],
        },
      ],
    });
    await runCommand(upgradeLocator, {
      create: "schema",
      input: [
        {
          name: "comment",
          properties: [
            { name: "task", type: "task", owner: null, inverse_name: "comments", inverse_is_array: null },
            { name: "author", type: "person", mandatory: null },
            { name: "body", type: "markdown" },
            { name: "created_at", type: "date_time", default_value: "${now()}" },
          ],
        },
      ],
    });
    await upgradeDataset(locator, upgradeLocator);
  }

  // The optional `lock(rest)` of the Persistence Interface (see its doc comment):
  // run only for a format that provides it.
  describe.skipIf(impl.lock === undefined)(`lock conformance — ${formatPrefix}`, () => {
    const lock = (rest: string) => (impl.lock as NonNullable<PersistenceInterface["lock"]>)(rest);
    const restOf = (locator: string) => locator.slice(formatPrefix.length + 1);
    const pause = (ms: number) => new Promise<"waiting">((resolve) => setTimeout(() => resolve("waiting"), ms));

    async function dataVersion(rest: string): Promise<number> {
      return ((await impl.getDataset(rest)) as Record<string, number>).data_minor_version;
    }

    it("keeps a second holder waiting until the first releases", async () => {
      const locator = newLocator();
      await initDataset(locator, "lock-exclusion");
      const rest = restOf(locator);

      const first = await lock(rest);
      const second = lock(rest);
      const outcome = await Promise.race([second.then(() => "acquired" as const), pause(50)]);
      expect(outcome).toBe("waiting");

      await first();
      await (await second)();
    });

    it("two sessions writing at once lose no version increment and create every instance", async () => {
      const locator = newLocator();
      await setupTaskDemo(locator);
      const rest = restOf(locator);
      const before = await dataVersion(rest);
      const a = createApiSession();
      const b = createApiSession();
      const person = (name: string) => ({ kind: "create" as const, schema: "person", input: { name, email: `${name}@example.com` } });

      await Promise.all([
        ...[1, 2, 3, 4, 5].map((i) => a.runCommand(locator, person(`a${i}`))),
        ...[1, 2, 3, 4, 5].map((i) => b.runCommand(locator, person(`b${i}`))),
      ]);

      expect(await dataVersion(rest)).toBe(before + 10);
      expect((await runCommand(locator, { kind: "query", schema: "person" })).after).toHaveLength(10);
    });

    it("is released after a command that throws, and after a rolled-back transaction", async () => {
      const locator = newLocator();
      await setupTaskDemo(locator);
      const rest = restOf(locator);
      const session = createApiSession();

      await expect(session.runCommand(locator, { kind: "create", schema: "no_such_schema", input: { name: "x" } })).rejects.toBeTruthy();
      await (await lock(rest))();

      if (impl.supportsTransactions === true) {
        const tx = await session.beginTransaction(locator);
        await session.runCommand(locator, { kind: "create", schema: "person", input: { name: "p1", email: "p1@example.com" } });
        await session.rollbackTransaction(locator, tx);
        await (await lock(rest))();
      }
    });
  });

  describe(`command language conformance — ${formatPrefix}`, () => {
    it("runs the Model convention's worked command examples end-to-end", async () => {
      const locator = newLocator();
      await setupTaskDemo(locator);

      // --- Create — people, then tasks ---
      const peopleResult = await runCommand(locator, {
        kind: "create",
        schema: "person",
        input: [
          { name: "alice", email: "alice@example.com" },
          { name: "bob", email: "bob@example.com" },
        ],
      });
      expect(peopleResult.before).toEqual([]);
      expect(peopleResult.after).toHaveLength(2);
      expect(peopleResult.after[0]).toMatchObject({ name: "alice", email: "alice@example.com" });
      expect(peopleResult.after[1]).toMatchObject({ name: "bob", email: "bob@example.com" });

      const tasksResult = await runCommand(locator, {
        kind: "create",
        schema: "task",
        input: [
          { title: "Design the schema processing pass", priority: 3, assignee: "alice", tags: ["design"] },
          { title: "Write the persistence interface", assignee: "bob" },
          { title: "Draft the command examples", priority: 5, assignee: "alice", tags: ["docs", "urgent"] },
        ],
      });
      expect(tasksResult.after).toHaveLength(3);
      const [t1, t2, t3] = tasksResult.after as Record<string, unknown>[];
      expect(t1).toMatchObject({ title: "Design the schema processing pass", status: "open", priority: 3, assignee: "alice", tags: ["design"] });
      expect(t2).toMatchObject({ title: "Write the persistence interface", status: "open", priority: 0, assignee: "bob", tags: [] });
      expect(t3).toMatchObject({ title: "Draft the command examples", status: "open", priority: 5, assignee: "alice", tags: ["docs", "urgent"] });
      for (const t of [t1, t2, t3]) expect(typeof t.id).toBe("string");

      // --- Create — ownership and placeholders ---
      const commentResult = await runCommand(locator, {
        kind: "create",
        schema: "comment",
        input: [{ task: t1.id as string, author: "bob", body: "Should this also cover scalar_type constraints?" }],
      });
      expect(commentResult.after).toHaveLength(1);
      const c1 = commentResult.after[0] as Record<string, unknown>;
      expect(c1).toMatchObject({ task: t1.id, author: "bob", body: "Should this also cover scalar_type constraints?" });
      expect(typeof c1.created_at).toBe("string");
      expect(() => new Date(String(c1.created_at)).toISOString()).not.toThrow();
      // t1 changes only as a side effect of comment.task's inverse_name — updated-*, not before/after
      expect(commentResult["updated-before"]).toHaveLength(1);
      expect(commentResult["updated-after"]).toHaveLength(1);
      expect((commentResult["updated-before"][0] as Record<string, unknown>).id).toBe(t1.id);
      expect((commentResult["updated-before"][0] as Record<string, unknown>).comments).toEqual([]);
      expect((commentResult["updated-after"][0] as Record<string, unknown>).comments).toEqual([c1.id]);

      // --- Query — never mutates; `before` defaults to empty for a query
      // (before and after are always identical copies there, so filling both
      // by default would be pure duplication — see Result shaping);
      // `result: { before: true }` still fills it with the same copies as
      // `after` ---
      const queryResult = await runCommand(locator, {
        kind: "query",
        schema: "task",
        filters: { and: [{ status: "open" }, { or: [{ assignee: "alice" }, { priority: { gte: 3 } }] }] },
      });
      const queriedIds = (queryResult.after as Record<string, unknown>[]).map((t) => t.id).sort();
      expect(queriedIds).toEqual([t1.id, t3.id].sort());
      expect(queryResult.before).toEqual([]);

      const queryResultWithBefore = await runCommand(locator, {
        kind: "query",
        schema: "task",
        filters: { and: [{ status: "open" }, { or: [{ assignee: "alice" }, { priority: { gte: 3 } }] }] },
        result: { before: true },
      });
      expect(queryResultWithBefore.before).toEqual(queryResultWithBefore.after);

      // --- Update — patch and cycling ---
      const updateResult = await runCommand(locator, {
        kind: "update",
        schema: "task",
        filters: { status: "open" },
        input: [{ status: "in_progress" }, { status: "in_progress", priority: 1 }],
      });
      expect(updateResult.before).toHaveLength(3);
      const updatedById = new Map((updateResult.after as Record<string, unknown>[]).map((t) => [t.id, t]));
      expect(updatedById.get(t1.id)).toMatchObject({ status: "in_progress", priority: 3 }); // input[0]
      expect(updatedById.get(t2.id)).toMatchObject({ status: "in_progress", priority: 1 }); // input[1]
      expect(updatedById.get(t3.id)).toMatchObject({ status: "in_progress", priority: 5 }); // cycles back to input[0]

      // --- Delete — cascade ---
      const deleteResult = await runCommand(locator, { kind: "delete", schema: "task", filters: { id: t1.id } });
      expect(deleteResult.before).toHaveLength(1);
      expect(deleteResult.after).toEqual([]);
      expect(deleteResult["cascade-deleted"]).toHaveLength(1);
      expect((deleteResult["cascade-deleted"][0] as Record<string, unknown>).id).toBe(c1.id);

      const remainingTasks = await runCommand(locator, { kind: "query", schema: "task" });
      expect((remainingTasks.after as Record<string, unknown>[]).map((t) => t.id).sort()).toEqual([t2.id, t3.id].sort());
      const remainingComments = await runCommand(locator, { kind: "query", schema: "comment" });
      expect(remainingComments.after).toEqual([]);

      // --- Script — chaining a create into a create ---
      const scriptResult = await runScript(locator, {
        commands: [
          { as: "new_task", kind: "create", schema: "task", input: [{ title: "Ship the REPL", assignee: "alice" }] },
          {
            kind: "create",
            schema: "comment",
            input: [{ task: "${new_task.after.0.id}", author: "bob", body: "Linked to the persistence interface work." }],
          },
        ],
      });
      expect(scriptResult.after).toHaveLength(1);
      const c2 = scriptResult.after[0] as Record<string, unknown>;
      expect(c2).toMatchObject({ author: "bob", body: "Linked to the persistence interface work." });
      expect(typeof c2.task).toBe("string");
      const newTaskCheck = await runCommand(locator, { kind: "query", schema: "task", filters: { id: c2.task } });
      expect(newTaskCheck.after).toHaveLength(1);
      expect((newTaskCheck.after[0] as Record<string, unknown>).title).toBe("Ship the REPL");
    });

    it("rejects an update with empty input", async () => {
      const locator = newLocator();
      await setupTaskDemo(locator);
      await expect(runCommand(locator, { kind: "update", schema: "person", filters: {}, input: [] })).rejects.toMatchObject({
        code: "empty_input",
      });
    });

    it("refuses an array used as a value on a property that is not an array with type_mismatch", async () => {
      const locator = newLocator();
      await setupTaskDemo(locator);
      await expect(runCommand(locator, { kind: "query", schema: "task", filters: { title: ["a", "b"] } })).rejects.toMatchObject({
        code: "type_mismatch",
      });
    });

    it("rejects a command against an unknown schema", async () => {
      const locator = newLocator();
      await setupTaskDemo(locator);
      await expect(runCommand(locator, { kind: "query", schema: "nonexistent" })).rejects.toMatchObject({
        code: "unknown_schema",
      });
    });

    it("rejects an enum violation on create", async () => {
      const locator = newLocator();
      await setupTaskDemo(locator);
      await expect(
        runCommand(locator, { kind: "create", schema: "task", input: [{ title: "x", status: "bogus" }] }),
      ).rejects.toMatchObject({ code: "constraint_violation" });
    });

    it("rejects updating the key property", async () => {
      const locator = newLocator();
      await setupTaskDemo(locator);
      await runCommand(locator, { kind: "create", schema: "person", input: [{ name: "carol", email: "carol@example.com" }] });
      await expect(
        runCommand(locator, { kind: "update", schema: "person", filters: { name: "carol" }, input: [{ name: "dave" }] }),
      ).rejects.toMatchObject({ code: "constraint_violation" });
    });

    it("appends to a string property with the `append` text operation", async () => {
      const locator = newLocator();
      await setupTaskDemo(locator);
      await runCommand(locator, { kind: "create", schema: "task", input: [{ title: "Draft the command examples" }] });

      const result = await runCommand(locator, {
        kind: "update",
        schema: "task",
        filters: { title: "Draft the command examples" },
        input: { title: { append: " (v2)" } },
      });
      expect(result.before[0]).toMatchObject({ title: "Draft the command examples" });
      expect(result.after[0]).toMatchObject({ title: "Draft the command examples (v2)" });

      const stored = await runCommand(locator, { kind: "query", schema: "task", filters: { title: "Draft the command examples (v2)" } });
      expect(stored.after).toHaveLength(1);
    });

    it("replaces one occurrence in a string property with the `replace` text operation", async () => {
      const locator = newLocator();
      await setupTaskDemo(locator);
      await runCommand(locator, { kind: "create", schema: "task", input: [{ title: "Write the persistence interface" }] });

      const result = await runCommand(locator, {
        kind: "update",
        schema: "task",
        filters: { title: "Write the persistence interface" },
        input: { title: { replace: { find: "interface", with: "interface contract" } } },
      });
      expect(result.before[0]).toMatchObject({ title: "Write the persistence interface" });
      expect(result.after[0]).toMatchObject({ title: "Write the persistence interface contract" });

      await expect(
        runCommand(locator, {
          kind: "update",
          schema: "task",
          filters: { title: "Write the persistence interface contract" },
          input: { title: { replace: { find: "absent", with: "x" } } },
        }),
      ).rejects.toMatchObject({ code: "text_not_found" });
      await expect(
        runCommand(locator, {
          kind: "update",
          schema: "task",
          filters: { title: "Write the persistence interface contract" },
          input: { title: { replace: { find: "e", with: "E" } } },
        }),
      ).rejects.toMatchObject({ code: "text_not_unique" });
    });

    it("accepts the create:/query: sugar as an alias for kind:+schema:", async () => {
      const locator = newLocator();
      await setupTaskDemo(locator);

      const created = await runCommand(locator, {
        create: "person",
        input: [{ name: "erin", email: "erin@example.com" }],
      });
      expect(created.after).toHaveLength(1);
      expect(created.after[0]).toMatchObject({ name: "erin", email: "erin@example.com" });

      const queried = await runCommand(locator, { query: "person", filters: { name: "erin" } });
      expect(queried.after).toHaveLength(1);
    });

    it("applies the sugar within a script's script_command steps too", async () => {
      const locator = newLocator();
      await setupTaskDemo(locator);
      // comment.author is a relation to person — validateRelationTargets
      // (command.ts) now rejects a value that isn't a real person's key, so
      // this needs one to exist first; the point of the test is that both
      // script steps ran as create, not the content of the comment.
      await runCommand(locator, { kind: "create", schema: "person", input: [{ name: "nobody", email: "nobody@example.com" }] });

      const scriptResult = await runScript(locator, {
        commands: [
          { as: "new_task", create: "task", input: [{ title: "Sugar in a script" }] },
          { create: "comment", input: [{ task: "${new_task.after.0.id}", author: "nobody", body: "n/a" }] },
        ],
      });
      expect(scriptResult.after).toHaveLength(1);
    });

    it("rejects a command with neither kind nor a sugar key", async () => {
      const locator = newLocator();
      await setupTaskDemo(locator);
      await expect(runCommand(locator, { schema: "person" })).rejects.toMatchObject({
        code: "missing_command_kind",
      });
    });

    it("rejects kind: and a sugar key given together", async () => {
      const locator = newLocator();
      await setupTaskDemo(locator);
      await expect(runCommand(locator, { kind: "query", create: "person" })).rejects.toMatchObject({
        code: "ambiguous_command_kind",
      });
    });

    it("rejects two sugar keys given together", async () => {
      const locator = newLocator();
      await setupTaskDemo(locator);
      await expect(runCommand(locator, { create: "person", update: "person" })).rejects.toMatchObject({
        code: "ambiguous_command_kind",
      });
    });
  });

  /**
   * A second, smaller model covering a virtual (inverse) relation reached
   * through `extends` — packages/core/docs/spec/model-command-language.md#schema-processing's
   * "Virtual relations".
   *
   * `bucket`/`item`/`special_item`: an ordinary declared inverse on a schema
   * that is then extended. Schema Processing flattens `extends`, so
   * `special_item` carries `item`'s own `bucket` relation, and the inverse
   * `bucket.items` has to stay typed `item` — the schema declaring it — for
   * instances of both to be valid targets.
   */
  async function setupVirtualRelations(locator: string): Promise<void> {
    await initDataset(locator, "virtual-relations");
    const upgradeLocator = await createUpgradeLocator(locator);
    await runCommand(upgradeLocator, {
      create: "schema",
      input: [
        {
          name: "bucket",
          shared_by_name: null,
          properties: [
            { name: "name", type: "identifier" },
            { name: "title", type: "string" },
          ],
        },
      ],
    });
    await runCommand(upgradeLocator, {
      create: "schema",
      input: [
        {
          name: "item",
          shared_by_name: null,
          properties: [
            { name: "name", type: "identifier" },
            { name: "bucket", type: "bucket", inverse_name: "items", inverse_is_array: null },
          ],
        },
      ],
    });
    await runCommand(upgradeLocator, { create: "schema", input: [{ name: "special_item", extends: "item" }] });
    await upgradeDataset(locator, upgradeLocator);
  }

  describe(`virtual relation conformance — ${formatPrefix}`, () => {
    it("types a relation's generated inverse to the schema declaring it, so instances of an extending schema are valid targets", async () => {
      const locator = newLocator();
      await setupVirtualRelations(locator);

      await runCommand(locator, { create: "bucket", input: [{ name: "b1", title: "first" }] });
      await runCommand(locator, { create: "item", input: [{ name: "i1", bucket: "b1" }] });
      await runCommand(locator, { create: "special_item", input: [{ name: "s1", bucket: "b1" }] });

      const read = await runCommand(locator, { query: "bucket", filters: { name: "b1" } });
      expect(read.after[0]).toMatchObject({ name: "b1", items: ["i1", "s1"] });

      // Writing the bucket back validates its own relation targets, `items`
      // included: a generated property typed to an extending schema instead
      // of the declaring one rejects every instance of its siblings.
      const updated = await runCommand(locator, { update: "bucket", filters: { name: "b1" }, input: [{ title: "renamed" }] });
      expect(updated.after[0]).toMatchObject({ title: "renamed", items: ["i1", "s1"] });
    });

    it("creates two schemas that reference each other through inverse relations in one command, whatever their order", async () => {
      const locator = newLocator();
      await initDataset(locator, "mutual-inverse-relations");
      const upgradeLocator = await createUpgradeLocator(locator);
      await runCommand(upgradeLocator, {
        create: "schema",
        input: [
          {
            name: "actor",
            shared_by_name: null,
            properties: [
              { name: "name", type: "identifier" },
              { name: "scope", type: "scope", inverse_name: "actors", inverse_is_array: null },
            ],
          },
          {
            name: "scope",
            shared_by_name: null,
            properties: [
              { name: "name", type: "identifier" },
              { name: "owning_actor", type: "actor", inverse_name: "inner_scopes", inverse_is_array: null },
            ],
          },
        ],
      });
      await upgradeDataset(locator, upgradeLocator);

      await runCommand(locator, { create: "scope", input: [{ name: "plant" }] });
      await runCommand(locator, { create: "actor", input: [{ name: "press", scope: "plant" }] });
      await runCommand(locator, { create: "scope", input: [{ name: "cell", owning_actor: "press" }] });

      const plant = await runCommand(locator, { query: "scope", filters: { name: "plant" } });
      expect(plant.after[0]).toMatchObject({ name: "plant", actors: ["press"] });
      const press = await runCommand(locator, { query: "actor", filters: { name: "press" } });
      expect(press.after[0]).toMatchObject({ name: "press", scope: "plant", inner_scopes: ["cell"] });
    });
  });

  /**
   * packages/core/docs/spec/meta-model.md#relations (revised 2026-08-28): "A directly
   * declared relation is always single-valued ... a many-to-many
   * relationship cannot be declared directly: it must be reified as its own
   * schema, holding a direct relation to each side." T030's "New tests
   * required" — no coverage existed at all for either half before this.
   */
  /**
   * A base schema that owns a list of notes, and two schemas extending it:
   * `note.annotated` targets `annotable`, so the generated inverse
   * `annotable.notes` is carried by `actor` and `scope`. Only the link from the
   * note to the annotated instance is stored; the `notes` array is derived.
   */
  async function setupAnnotable(locator: string): Promise<void> {
    await initDataset(locator, "annotable");
    const upgradeLocator = await createUpgradeLocator(locator);
    await runCommand(upgradeLocator, { create: "schema", input: [{ name: "annotable", is_root: null }] });
    await runCommand(upgradeLocator, {
      create: "schema",
      input: [
        {
          name: "note",
          properties: [
            { name: "annotated", type: "annotable", owner: null, inverse_name: "notes", inverse_is_array: null },
            { name: "content", type: "markdown" },
          ],
        },
      ],
    });
    await runCommand(upgradeLocator, {
      create: "schema",
      input: [{ name: "actor", extends: "annotable", properties: [{ name: "display_name", type: "string" }] }],
    });
    await runCommand(upgradeLocator, {
      create: "schema",
      input: [{ name: "scope", extends: "annotable", properties: [{ name: "display_name", type: "string" }] }],
    });
    await upgradeDataset(locator, upgradeLocator);
  }

  describe(`annotable base conformance — ${formatPrefix}`, () => {
    const idOf = (row: unknown): string => (row as Record<string, unknown>).id as string;
    const idsOf = (rows: unknown[]): string[] => rows.map(idOf).sort();

    async function seedAnnotable(locator: string): Promise<{ actor: string; scope: string; notes: string[] }> {
      const actor = idOf((await runCommand(locator, { create: "actor", input: [{ display_name: "A1" }] })).after[0]);
      const scope = idOf((await runCommand(locator, { create: "scope", input: [{ display_name: "S1" }] })).after[0]);
      const created = await runCommand(locator, {
        create: "note",
        input: [
          { annotated: actor, content: "on the actor, first" },
          { annotated: actor, content: "on the actor, second" },
          { annotated: scope, content: "on the scope" },
        ],
      });
      return { actor, scope, notes: created.after.map(idOf) };
    }

    it("attaches a note to an instance of either extending schema and derives the notes array on each", async () => {
      const locator = newLocator();
      await setupAnnotable(locator);
      const { actor, scope, notes } = await seedAnnotable(locator);

      const readActor = await runCommand(locator, { query: "actor", filters: { id: actor } });
      expect([...((readActor.after[0] as Record<string, unknown>).notes as string[])].sort()).toEqual([notes[0], notes[1]].sort());
      const readScope = await runCommand(locator, { query: "scope", filters: { id: scope } });
      expect((readScope.after[0] as Record<string, unknown>).notes).toEqual([notes[2]]);
    });

    it.each(["json", "yaml"] as const)(
      "keeps each note linked to its annotated instance through dumpDataset/restoreDataset (%s)",
      async (format) => {
        const locator = newLocator();
        await setupAnnotable(locator);
        const { actor, scope, notes } = await seedAnnotable(locator);

        const restoreLocator = newLocator();
        const result = await restoreDataset(restoreLocator, await dumpDataset(locator, format), format);
        expect(result.pendingRealignment).toEqual([]);

        const restoredNotes = await runCommand(restoreLocator, { query: "note" });
        expect(idsOf(restoredNotes.after)).toEqual([...notes].sort());
        const annotatedOf = (id: string) =>
          (restoredNotes.after.find((n) => idOf(n) === id) as Record<string, unknown>).annotated;
        expect(annotatedOf(notes[0])).toBe(actor);
        expect(annotatedOf(notes[1])).toBe(actor);
        expect(annotatedOf(notes[2])).toBe(scope);

        // the derived arrays are rebuilt from the stored links only
        const restoredActor = await runCommand(restoreLocator, { query: "actor", filters: { id: actor } });
        expect([...((restoredActor.after[0] as Record<string, unknown>).notes as string[])].sort()).toEqual(
          [notes[0], notes[1]].sort(),
        );
        const restoredScope = await runCommand(restoreLocator, { query: "scope", filters: { id: scope } });
        expect((restoredScope.after[0] as Record<string, unknown>).notes).toEqual([notes[2]]);
      },
    );

    it("deletes the notes of an annotated instance with it, and leaves the others", async () => {
      const locator = newLocator();
      await setupAnnotable(locator);
      const { actor, notes } = await seedAnnotable(locator);

      const deleted = await runCommand(locator, { delete: "actor", filters: { id: actor } });
      expect(idsOf(deleted["cascade-deleted"])).toEqual([notes[0], notes[1]].sort());
      expect(idsOf((await runCommand(locator, { query: "note" })).after)).toEqual([notes[2]]);
    });

    it("refuses a note whose annotated instance does not exist", async () => {
      const locator = newLocator();
      await setupAnnotable(locator);
      await expect(
        runCommand(locator, { create: "note", input: [{ annotated: "6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f", content: "orphan" }] }),
      ).rejects.toBeDefined();
    });

    it.each([
      ["the base then the note", ["annotable", "note", "actor"]],
      ["the note before the base", ["note", "annotable", "actor"]],
    ] as const)("lists the notes on an extending schema when all the schemas are created in one command, %s", async (_label, order) => {
      const locator = newLocator();
      await initDataset(locator, "annotable-one-command");
      const upgradeLocator = await createUpgradeLocator(locator);
      const definitions: Record<string, Record<string, unknown>> = {
        annotable: { name: "annotable", is_root: null },
        note: {
          name: "note",
          properties: [
            { name: "annotated", type: "annotable", owner: null, inverse_name: "notes", inverse_is_array: null },
            { name: "content", type: "markdown" },
          ],
        },
        actor: { name: "actor", extends: "annotable", properties: [{ name: "display_name", type: "string" }] },
      };
      await runCommand(upgradeLocator, { create: "schema", input: order.map((name) => definitions[name]) });
      await upgradeDataset(locator, upgradeLocator);

      const actor = idOf((await runCommand(locator, { create: "actor", input: [{ display_name: "A1" }] })).after[0]);
      const note = idOf((await runCommand(locator, { create: "note", input: [{ annotated: actor, content: "n" }] })).after[0]);
      const read = await runCommand(locator, { query: "actor", filters: { id: actor } });
      expect((read.after[0] as Record<string, unknown>).notes).toEqual([note]);
    });

    it("adds the base to schemas that already hold instances through a model upgrade, keeping their data", async () => {
      const locator = newLocator();
      await initDataset(locator, "annotable-upgrade");
      const first = await createUpgradeLocator(locator);
      await runCommand(first, {
        create: "schema",
        input: [
          { name: "actor", is_root: null, properties: [{ name: "display_name", type: "string" }] },
          { name: "scope", is_root: null, properties: [{ name: "display_name", type: "string" }] },
        ],
      });
      await upgradeDataset(locator, first);
      const actor = idOf((await runCommand(locator, { create: "actor", input: [{ display_name: "A1" }] })).after[0]);
      const scope = idOf((await runCommand(locator, { create: "scope", input: [{ display_name: "S1" }] })).after[0]);

      const second = await createUpgradeLocator(locator);
      await runCommand(second, { create: "schema", input: [{ name: "annotable", is_root: null }] });
      await runCommand(second, {
        create: "schema",
        input: [
          {
            name: "note",
            properties: [
              { name: "annotated", type: "annotable", owner: null, inverse_name: "notes", inverse_is_array: null },
              { name: "content", type: "markdown" },
            ],
          },
        ],
      });
      await runCommand(second, {
        update: "schema",
        filters: { name: "actor" },
        input: { extends: "annotable", is_root: null, properties: [{ name: "display_name", type: "string" }] },
      });
      await runCommand(second, {
        update: "schema",
        filters: { name: "scope" },
        input: { extends: "annotable", is_root: null, properties: [{ name: "display_name", type: "string" }] },
      });

      const check = await checkUpgrade(locator, second);
      expect(check.lostSchema).toEqual([]);
      expect(check.modifiedSchema).toEqual([]);
      await upgradeDataset(locator, second);

      // the instances kept their data and now carry a derived, empty `notes`
      const readActor = await runCommand(locator, { query: "actor", filters: { id: actor } });
      expect(readActor.after[0]).toMatchObject({ id: actor, display_name: "A1", notes: [] });
      const readScope = await runCommand(locator, { query: "scope", filters: { id: scope } });
      expect(readScope.after[0]).toMatchObject({ id: scope, display_name: "S1", notes: [] });

      // and accept notes
      const note = idOf((await runCommand(locator, { create: "note", input: [{ annotated: actor, content: "after the upgrade" }] })).after[0]);
      const reread = await runCommand(locator, { query: "actor", filters: { id: actor } });
      expect((reread.after[0] as Record<string, unknown>).notes).toEqual([note]);
    });

    it("accepts an owned schema extending the base, and deletes its notes with the chain of owners", async () => {
      const locator = newLocator();
      await setupAnnotable(locator);
      const upgradeLocator = await createUpgradeLocator(locator);
      await runCommand(upgradeLocator, {
        create: "schema",
        input: [
          {
            name: "held_item",
            extends: "annotable",
            properties: [{ name: "actor", type: "actor", owner: null, inverse_name: "held_items", inverse_is_array: null }],
          },
        ],
      });
      await upgradeDataset(locator, upgradeLocator);

      const { actor, notes } = await seedAnnotable(locator);
      const held = idOf((await runCommand(locator, { create: "held_item", input: [{ actor }] })).after[0]);
      const heldNote = idOf(
        (await runCommand(locator, { create: "note", input: [{ annotated: held, content: "on the held item" }] })).after[0],
      );
      const readHeld = await runCommand(locator, { query: "held_item", filters: { id: held } });
      expect((readHeld.after[0] as Record<string, unknown>).notes).toEqual([heldNote]);

      await runCommand(locator, { delete: "actor", filters: { id: actor } });
      expect((await runCommand(locator, { query: "held_item" })).after).toEqual([]);
      expect(idsOf((await runCommand(locator, { query: "note" })).after)).toEqual([notes[2]]);
    });
  });

  describe(`relation cardinality conformance — ${formatPrefix}`, () => {
    it("rejects a directly declared relation with is_array: true, with constraint_violation", async () => {
      const locator = newLocator();
      await initDataset(locator, "cardinality-reject");
      const upgradeLocator = await createUpgradeLocator(locator);
      await runCommand(upgradeLocator, {
        create: "schema",
        input: [{ name: "target", shared_by_name: null, properties: [{ name: "name", type: "identifier" }] }],
      });

      await expect(
        runCommand(upgradeLocator, {
          create: "schema",
          input: [{ name: "source", properties: [{ name: "targets", type: "[target]", inverse_name: "sources" }] }],
        }),
      ).rejects.toMatchObject({ code: "constraint_violation" });
    });

    it("models a many-to-many relationship by reifying it as its own schema holding a direct relation to each side", async () => {
      const locator = newLocator();
      await initDataset(locator, "reified-m2m");
      const upgradeLocator = await createUpgradeLocator(locator);
      await runCommand(upgradeLocator, {
        create: "schema",
        input: [{ name: "student", shared_by_name: null, properties: [{ name: "name", type: "identifier" }] }],
      });
      await runCommand(upgradeLocator, {
        create: "schema",
        input: [{ name: "course", shared_by_name: null, properties: [{ name: "name", type: "identifier" }] }],
      });
      await runCommand(upgradeLocator, {
        create: "schema",
        input: [
          {
            name: "enrollment",
            shared_by_name: null,
            properties: [
              { name: "name", type: "identifier" },
              { name: "student", type: "student", mandatory: true, inverse_name: "enrollments", inverse_is_array: true },
              { name: "course", type: "course", mandatory: true, inverse_name: "enrollments", inverse_is_array: true },
            ],
          },
        ],
      });
      await upgradeDataset(locator, upgradeLocator);

      await runCommand(locator, { create: "student", input: [{ name: "alice" }, { name: "bob" }] });
      await runCommand(locator, { create: "course", input: [{ name: "math" }, { name: "art" }] });
      await runCommand(locator, {
        create: "enrollment",
        input: [
          { name: "e1", student: "alice", course: "math" },
          { name: "e2", student: "alice", course: "art" },
          { name: "e3", student: "bob", course: "math" },
        ],
      });

      const aliceRead = await runCommand(locator, { query: "student", filters: { name: "alice" } });
      expect(((aliceRead.after[0] as Record<string, unknown>).enrollments as string[]).slice().sort()).toEqual(["e1", "e2"]);

      const mathRead = await runCommand(locator, { query: "course", filters: { name: "math" } });
      expect(((mathRead.after[0] as Record<string, unknown>).enrollments as string[]).slice().sort()).toEqual(["e1", "e3"]);
    });
  });

  /**
   * The `singleton` constraint on a user schema: at most one instance in the
   * dataset, a second `create` fails with `constraint_violation` (`docs/authoring.md`
   * of `@scfloworg/core`, Schemas and keys).
   */
  describe(`singleton constraint conformance — ${formatPrefix}`, () => {
    it("refuses a second instance of a singleton schema and accepts one again after a delete", async () => {
      const locator = newLocator();
      await initDataset(locator, "singleton-schema");
      const upgradeLocator = await createUpgradeLocator(locator);
      await runCommand(upgradeLocator, {
        create: "schema",
        input: [{ name: "settings", shared_by_name: null, is_root: null, singleton: null, properties: [{ name: "name", type: "identifier" }] }],
      });
      await upgradeDataset(locator, upgradeLocator);

      await runCommand(locator, { create: "settings", input: [{ name: "main" }] });
      await expect(runCommand(locator, { create: "settings", input: [{ name: "other" }] })).rejects.toMatchObject({
        code: "constraint_violation",
      });
      const stored = await runCommand(locator, { query: "settings" });
      expect(stored.after).toHaveLength(1);

      await runCommand(locator, { delete: "settings", filters: { name: "main" } });
      const recreated = await runCommand(locator, { create: "settings", input: [{ name: "other" }] });
      expect(recreated.after).toHaveLength(1);
    });
  });

  /**
   * The `id` of an instance of a schema that is not `shared_by_name`: a generated
   * uuid, or the canonical lowercase uuid a `create` supplies; an id already in
   * use or malformed is refused, and an id created before uuids stays readable
   * (`docs/commands.md` and `docs/authoring.md` of `@scfloworg/core`).
   */
  describe(`uuid id conformance — ${formatPrefix}`, () => {
    const uuidShape = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    const suppliedId = "6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f";

    async function setupNote(locator: string): Promise<void> {
      await initDataset(locator, "uuid-ids");
      const upgradeLocator = await createUpgradeLocator(locator);
      await runCommand(upgradeLocator, {
        create: "schema",
        input: [{ name: "note", is_root: null, properties: [{ name: "title", type: "string" }] }],
      });
      await upgradeDataset(locator, upgradeLocator);
    }

    it("generates a distinct uuid for each created instance and finds it by that id", async () => {
      const locator = newLocator();
      await setupNote(locator);

      const created = await runCommand(locator, { create: "note", input: [{ title: "a" }, { title: "b" }] });
      const ids = created.after.map((note) => (note as Record<string, unknown>).id as string);

      expect(ids).toHaveLength(2);
      for (const id of ids) expect(id).toMatch(uuidShape);
      expect(new Set(ids).size).toBe(2);
      const found = await runCommand(locator, { query: "note", filters: { id: ids[0] } });
      expect(found.after).toHaveLength(1);
    });

    it("keeps the id a create supplies and refuses it once it is in use", async () => {
      const locator = newLocator();
      await setupNote(locator);

      const created = await runCommand(locator, { create: "note", input: [{ id: suppliedId, title: "a" }] });
      expect((created.after[0] as Record<string, unknown>).id).toBe(suppliedId);

      await expect(runCommand(locator, { create: "note", input: [{ id: suppliedId, title: "b" }] })).rejects.toMatchObject({
        code: "constraint_violation",
      });
      const stored = await runCommand(locator, { query: "note" });
      expect(stored.after).toHaveLength(1);
    });

    it("refuses a supplied id that is not a canonical lowercase uuid", async () => {
      const locator = newLocator();
      await setupNote(locator);

      for (const id of [suppliedId.toUpperCase(), "note_1", ""]) {
        await expect(runCommand(locator, { create: "note", input: [{ id, title: "a" }] })).rejects.toMatchObject({
          code: "constraint_violation",
        });
      }
      expect((await runCommand(locator, { query: "note" })).after).toHaveLength(0);
    });

    it("accepts the id of a deleted instance again", async () => {
      const locator = newLocator();
      await setupNote(locator);
      await runCommand(locator, { create: "note", input: [{ id: suppliedId, title: "a" }] });
      await runCommand(locator, { delete: "note", filters: { id: suppliedId } });

      const recreated = await runCommand(locator, { create: "note", input: [{ id: suppliedId, title: "b" }] });

      expect((recreated.after[0] as Record<string, unknown>).id).toBe(suppliedId);
    });

    it("reads a stored instance whose id predates uuids", async () => {
      const locator = newLocator();
      await setupNote(locator);
      await impl.putInstance(locator.slice(formatPrefix.length + 1), "note", "note_7", { id: "note_7", title: "old" }, NO_ROLES);

      const found = await runCommand(locator, { query: "note", filters: { id: "note_7" } });
      expect(found.after).toEqual([{ id: "note_7", title: "old" }]);
      const updated = await runCommand(locator, { update: "note", filters: { id: "note_7" }, input: { title: "new" } });
      expect(updated.after).toEqual([{ id: "note_7", title: "new" }]);
    });
  });

  describe(`dataset lifecycle conformance — ${formatPrefix}`, () => {
    it("stores a dataset name patch", async () => {
      const locator = newLocator();
      await initDataset(locator, "original");
      
      await runCommand(locator, { kind: "update", schema: "dataset", input: { name: "renamed" } });
      
      const dataset = await queryDataset(locator);
      expect(dataset).not.toBeNull();
      expect((dataset as Record<string, unknown>).name).toBe("renamed");
    });

    it("initDataset rejects a duplicate locator", async () => {
      const locator = newLocator();
      await initDataset(locator, "dupe-check");
      await expect(initDataset(locator, "again")).rejects.toMatchObject({ code: "dataset_already_exists" });
    });

    it("queryDataset returns null for a missing dataset and the transient form for an existing one", async () => {
      const locator = newLocator();
      expect(await queryDataset(locator)).toBeNull();

      await setupTaskDemo(locator);
      const found = await queryDataset(locator);
      expect(found).toMatchObject({
        name: "tasks-demo",
        model_major_version: 0,
        data_major_version: 0,
      });
      const record = found as Record<string, unknown>;
      expect(record.schemas).toEqual(expect.arrayContaining(["person", "task", "comment"]));
      expect(record.scalar_types).toEqual(expect.arrayContaining(["task_status"]));
      expect(record.imports).toEqual([]);
      expect(typeof record.created_at).toBe("string");
      expect(typeof record.updated_at).toBe("string");
    });

    it("bumpMajorVersions bumps only the requested part(s), resetting that part's minor to 0 and leaving the other part's major untouched", async () => {
      const locator = newLocator();
      await setupTaskDemo(locator); // 4 schema/scalar_type changes -> model_minor_version > 0
      await runCommand(locator, { kind: "create", schema: "person", input: [{ name: "yara", email: "yara@example.com" }] }); // -> data_minor_version > 0
      const before = (await queryDataset(locator)) as Record<string, unknown>;
      expect(before.model_minor_version).toBeGreaterThan(0);
      expect(before.data_minor_version).toBeGreaterThan(0);

      const afterModelBump = (await bumpMajorVersions(locator, true, false)) as Record<string, unknown>;
      expect(afterModelBump.model_major_version).toBe(1);
      expect(afterModelBump.model_minor_version).toBe(0);
      expect(afterModelBump.data_major_version).toBe(0);
      expect(afterModelBump.data_minor_version).toBe(before.data_minor_version); // untouched — data wasn't bumped

      const afterDataBump = (await bumpMajorVersions(locator, false, true)) as Record<string, unknown>;
      expect(afterDataBump.model_major_version).toBe(1);
      expect(afterDataBump.data_major_version).toBe(1);
      expect(afterDataBump.data_minor_version).toBe(0);

      const afterBothBump = (await bumpMajorVersions(locator, true, true)) as Record<string, unknown>;
      expect(afterBothBump.model_major_version).toBe(2);
      expect(afterBothBump.data_major_version).toBe(2);

      await expect(bumpMajorVersions(newLocator(), true, false)).rejects.toMatchObject({ code: "dataset_not_found" });
    });

    it("deleteDataset returns the pre-deletion transient form and the dataset stops resolving", async () => {
      const locator = newLocator();
      await setupTaskDemo(locator);
      await runCommand(locator, { kind: "create", schema: "person", input: [{ name: "zoe", email: "zoe@example.com" }] });

      const deleted = (await deleteDataset(locator)) as Record<string, unknown>;
      expect(deleted.name).toBe("tasks-demo");
      expect(deleted.schemas).toEqual(expect.arrayContaining(["person", "task", "comment"]));
      expect(deleted.scalar_types).toEqual(expect.arrayContaining(["task_status"]));

      expect(await queryDataset(locator)).toBeNull();
      await expect(deleteDataset(locator)).rejects.toMatchObject({ code: "dataset_not_found" });
      await expect(runCommand(locator, { kind: "query", schema: "person" })).rejects.toMatchObject({ code: "dataset_not_found" });
    });

    it.each(["json", "yaml"] as const)("dumpDataset/restoreDataset round-trips model and data (%s)", async (format) => {
      const locator = newLocator();
      await setupTaskDemo(locator);
      const created = await runCommand(locator, {
        kind: "create",
        schema: "person",
        input: [{ name: "wade", email: "wade@example.com" }],
      });
      const person = created.after[0] as Record<string, unknown>;
      await runCommand(locator, {
        kind: "create",
        schema: "task",
        input: [{ title: "Dump me", assignee: person.name, tags: ["dump"] }],
      });

      const dump = await dumpDataset(locator, format);
      expect(typeof dump).toBe("string");

      const restoreLocator = newLocator();
      const result = await restoreDataset(restoreLocator, dump, format);
      expect(result.pendingRealignment).toEqual([]);

      const original = (await queryDataset(locator)) as Record<string, unknown>;
      const restored = result.dataset as Record<string, unknown>;
      expect(restored.name).toBe(original.name);
      expect(restored.model_major_version).toBe(original.model_major_version);
      expect(restored.model_minor_version).toBe(original.model_minor_version);
      expect(restored.data_major_version).toBe(original.data_major_version);
      expect(restored.data_minor_version).toBe(original.data_minor_version);
      expect(restored.created_at).toBe(original.created_at);
      expect((restored.schemas as unknown[]).sort()).toEqual((original.schemas as unknown[]).sort());
      expect((restored.scalar_types as unknown[]).sort()).toEqual((original.scalar_types as unknown[]).sort());

      // the restored dataset is independently queryable via the normal command
      // language — not just a passthrough of the dump string
      const restoredPeople = await runCommand(restoreLocator, { kind: "query", schema: "person", filters: { name: "wade" } });
      expect(restoredPeople.after).toHaveLength(1);
      expect(restoredPeople.after[0]).toMatchObject({ name: "wade", email: "wade@example.com" });

      const restoredTasks = await runCommand(restoreLocator, { kind: "query", schema: "task", filters: { title: "Dump me" } });
      expect(restoredTasks.after).toHaveLength(1);
      expect(restoredTasks.after[0]).toMatchObject({ title: "Dump me", assignee: "wade", tags: ["dump"] });

      // restoring into an already-used locator is rejected, the original dataset untouched
      await expect(restoreDataset(locator, dump, format)).rejects.toMatchObject({ code: "dataset_already_exists" });
    });

    it("dumpDataset rejects a missing dataset", async () => {
      await expect(dumpDataset(newLocator(), "json")).rejects.toMatchObject({ code: "dataset_not_found" });
    });

    it("restoreDataset rejects a dump that doesn't parse or doesn't have the expected shape", async () => {
      await expect(restoreDataset(newLocator(), "{not valid json", "json")).rejects.toMatchObject({ code: "invalid_dump" });
      await expect(restoreDataset(newLocator(), JSON.stringify({ schemas: {}, scalar_types: {}, data: {} }), "json")).rejects.toMatchObject({
        code: "invalid_dump",
      });
      await expect(restoreDataset(newLocator(), JSON.stringify([1, 2, 3]), "json")).rejects.toMatchObject({ code: "invalid_dump" });
    });
  });

  /**
   * Map types — the "Map types" paragraph of the `property` part and the
   * `internationalization` part of the `core` dataset: a property typed
   * `localized_string`, `localized_markdown` or `{K: V}` stores its entries,
   * answers to `set` and `remove`, filters on an entry (`display_name.fr`),
   * and survives a dump and a restore.
   */
  async function setupLocalized(locator: string): Promise<void> {
    await initDataset(locator, "localized");
    const upgradeLocator = await createUpgradeLocator(locator);
    await runCommand(upgradeLocator, {
      create: "schema",
      input: [
        {
          name: "plant",
          shared_by_name: null,
          properties: [
            { name: "name", type: "identifier" },
            { name: "display_name", type: "localized_string", min_length: 1 },
            { name: "description", type: "localized_markdown" },
            { name: "synonyms", type: "{language_code: string}" },
          ],
        },
      ],
    });
    await upgradeDataset(locator, upgradeLocator);
  }

  /**
   * The `is_set` property constraint — the *Sets* paragraphs of the
   * `property_constraints` and `filter` parts of the `core` dataset: a set holds
   * distinct entries of an enum scalar type, stored in the order of the enum, and
   * a filter compares it without regard to order.
   */
  async function setupSet(locator: string): Promise<void> {
    await initDataset(locator, "sets");
    const upgradeLocator = await createUpgradeLocator(locator);
    await runCommand(upgradeLocator, {
      create: "scalar_type",
      input: [{ name: "color", extends: "string", enum: ["red", "green", "blue"] }],
    });
    await runCommand(upgradeLocator, {
      create: "schema",
      input: [
        {
          name: "flower",
          shared_by_name: null,
          properties: [
            { name: "name", type: "identifier" },
            { name: "colors", type: "color", is_set: null, max_length: 2 },
          ],
        },
      ],
    });
    await upgradeDataset(locator, upgradeLocator);
  }

  describe(`set constraint conformance — ${formatPrefix}`, () => {
    it("stores the entries in the order of the enum and answers a filter without regard to order", async () => {
      const locator = newLocator();
      await setupSet(locator);

      await runCommand(locator, { create: "flower", input: [{ name: "iris", colors: ["blue", "red"] }, { name: "fern" }] });

      const iris = (await runCommand(locator, { query: "flower", filters: { name: "iris" } })).after[0];
      expect(iris).toMatchObject({ colors: ["red", "blue"] });
      const fern = (await runCommand(locator, { query: "flower", filters: { name: "fern" } })).after[0];
      expect(fern).toMatchObject({ colors: [] });

      const found = await runCommand(locator, { query: "flower", filters: { colors: ["blue", "red"] } });
      expect(found.after.map((i) => (i as Record<string, unknown>).name)).toEqual(["iris"]);
      const containing = await runCommand(locator, { query: "flower", filters: { colors: { contains: "blue" } } });
      expect(containing.after.map((i) => (i as Record<string, unknown>).name)).toEqual(["iris"]);
    });

    it("refuses a duplicate, an entry outside the enum and a set over max_length, with constraint_violation", async () => {
      const locator = newLocator();
      await setupSet(locator);
      await runCommand(locator, { create: "flower", input: [{ name: "iris", colors: ["red"] }] });

      await expect(runCommand(locator, { create: "flower", input: [{ name: "a", colors: ["red", "red"] }] })).rejects.toMatchObject({
        code: "constraint_violation",
      });
      await expect(runCommand(locator, { create: "flower", input: [{ name: "a", colors: ["purple"] }] })).rejects.toMatchObject({
        code: "constraint_violation",
      });
      await expect(runCommand(locator, { create: "flower", input: [{ name: "a", colors: ["red", "green", "blue"] }] })).rejects.toMatchObject({
        code: "constraint_violation",
      });
      await expect(
        runCommand(locator, { update: "flower", filters: { name: "iris" }, input: { colors: ["green", "green"] } }),
      ).rejects.toMatchObject({ code: "constraint_violation" });

      const stored = (await runCommand(locator, { query: "flower", filters: { name: "iris" } })).after[0];
      expect(stored).toMatchObject({ colors: ["red"] });
    });

    it("refuses is_set on a scalar type without enum and on a relation, with constraint_violation", async () => {
      const locator = newLocator();
      await initDataset(locator, "set-reject");
      const upgradeLocator = await createUpgradeLocator(locator);
      await runCommand(upgradeLocator, {
        create: "schema",
        input: [{ name: "target", shared_by_name: null, properties: [{ name: "name", type: "identifier" }] }],
      });

      await expect(
        runCommand(upgradeLocator, {
          create: "schema",
          input: [{ name: "words", shared_by_name: null, properties: [{ name: "name", type: "identifier" }, { name: "list", type: "string", is_set: null }] }],
        }),
      ).rejects.toMatchObject({ code: "constraint_violation" });
      await expect(
        runCommand(upgradeLocator, {
          create: "schema",
          input: [{ name: "source", properties: [{ name: "link", type: "target", is_set: null }] }],
        }),
      ).rejects.toMatchObject({ code: "constraint_violation" });
    });
  });

  /**
   * The `extension` relation constraint — the *Extensions* paragraphs of the
   * `relations`, `schema_processing` and `command` parts of the `core` dataset:
   * the properties of an extension schema are properties of the schema it
   * extends in every command, its instance is created and deleted with the
   * extended one, and a command cannot name the extension schema.
   */
  const extensionModel = [
    { name: "task", shared_by_name: null, properties: [{ name: "name", type: "identifier" }, { name: "title", type: "string" }] },
    {
      name: "task_billing",
      properties: [
        { name: "task", type: "task", extension: null },
        { name: "rate", type: "integer", default_value: 10 },
      ],
    },
  ];

  async function setupExtension(locator: string): Promise<void> {
    await initDataset(locator, "extensions");
    const upgradeLocator = await createUpgradeLocator(locator);
    await runCommand(upgradeLocator, { create: "schema", input: extensionModel });
    await upgradeDataset(locator, upgradeLocator);
  }

  describe(`extension constraint conformance — ${formatPrefix}`, () => {
    it("creates, reads, filters, updates and deletes the properties of an extension through the extended schema", async () => {
      const locator = newLocator();
      await setupExtension(locator);

      await runCommand(locator, { create: "task", input: [{ name: "t1", title: "A", rate: 25 }, { name: "t2" }] });
      const t2 = (await runCommand(locator, { query: "task", filters: { name: "t2" } })).after[0];
      expect(t2).toMatchObject({ name: "t2", rate: 10 });
      const found = await runCommand(locator, { query: "task", filters: { rate: { gte: 20 } } });
      expect(found.after.map((i) => (i as Record<string, unknown>).name)).toEqual(["t1"]);

      const updated = await runCommand(locator, { update: "task", filters: { name: "t1" }, input: { rate: 30, title: "B" } });
      expect(updated.before[0]).toMatchObject({ rate: 25, title: "A" });
      expect(updated.after[0]).toMatchObject({ rate: 30, title: "B" });

      const deleted = await runCommand(locator, { delete: "task", filters: { name: "t1" } });
      expect(deleted["cascade-deleted"]).toEqual([]);
      const remaining = await runCommand(locator, { query: "task" });
      expect(remaining.after.map((i) => (i as Record<string, unknown>).name)).toEqual(["t2"]);
    });

    it("refuses a command on the extension schema with extension_not_addressable", async () => {
      const locator = newLocator();
      await setupExtension(locator);
      await expect(runCommand(locator, { query: "task_billing" })).rejects.toMatchObject({ code: "extension_not_addressable" });
      await expect(runCommand(locator, { create: "task_billing", input: [{ rate: 1 }] })).rejects.toMatchObject({ code: "extension_not_addressable" });
    });

    it("refuses an extension schema that breaks the rules, with constraint_violation", async () => {
      const locator = newLocator();
      await initDataset(locator, "extension-reject");
      const upgradeLocator = await createUpgradeLocator(locator);
      await runCommand(upgradeLocator, { create: "schema", input: [extensionModel[0]] });
      await expect(
        runCommand(upgradeLocator, {
          create: "schema",
          input: [{ name: "task_billing", properties: [{ name: "task", type: "task", extension: null }, { name: "name", type: "identifier" }] }],
        }),
      ).rejects.toMatchObject({ code: "constraint_violation" });
      await expect(
        runCommand(upgradeLocator, {
          create: "schema",
          input: [{ name: "task_billing", properties: [{ name: "task", type: "task", extension: null }, { name: "rate", type: "integer" }] }],
        }),
      ).rejects.toMatchObject({ code: "constraint_violation" });
    });

    it("gives the instances that exist when an extension is added the defaults of its properties", async () => {
      const locator = newLocator();
      await initDataset(locator, "extension-upgrade");
      const first = await createUpgradeLocator(locator);
      await runCommand(first, { create: "schema", input: [extensionModel[0]] });
      await upgradeDataset(locator, first);
      await runCommand(locator, { create: "task", input: [{ name: "t1" }, { name: "t2" }] });

      const second = await createUpgradeLocator(locator);
      await runCommand(second, { create: "schema", input: [extensionModel[1]] });
      expect((await checkUpgrade(locator, second)).modifiedSchema).toEqual([]);
      await upgradeDataset(locator, second);

      const tasks = await runCommand(locator, { query: "task" });
      expect(tasks.after.map((i) => (i as Record<string, unknown>).rate)).toEqual([10, 10]);
    });
  });

  const onDeleteModel = [
    { name: "team", shared_by_name: null, properties: [{ name: "name", type: "identifier" }] },
    {
      // mandatory, no on_delete: restrict
      name: "member",
      shared_by_name: null,
      properties: [
        { name: "name", type: "identifier" },
        { name: "team", type: "team", mandatory: null },
      ],
    },
    {
      name: "badge",
      shared_by_name: null,
      properties: [
        { name: "name", type: "identifier" },
        { name: "team", type: "team", mandatory: null, on_delete: "cascade" },
      ],
    },
    {
      // optional, no on_delete: set_null
      name: "note",
      shared_by_name: null,
      properties: [
        { name: "name", type: "identifier" },
        { name: "team", type: "team" },
      ],
    },
    {
      name: "tag",
      shared_by_name: null,
      properties: [
        { name: "name", type: "identifier" },
        { name: "team", type: "team", on_delete: "restrict" },
      ],
    },
    {
      // owned by a badge, and mandatory on the same team: restrict, unless the same delete removes it
      name: "pass",
      shared_by_name: null,
      properties: [
        { name: "name", type: "identifier" },
        { name: "badge", type: "badge", mandatory: null, owner: null },
        { name: "team", type: "team", mandatory: null },
      ],
    },
  ];

  async function setupOnDelete(locator: string): Promise<void> {
    await initDataset(locator, "on-delete");
    const upgradeLocator = await createUpgradeLocator(locator);
    await runCommand(upgradeLocator, { create: "schema", input: onDeleteModel });
    await upgradeDataset(locator, upgradeLocator);
  }

  const namesOf = (instances: unknown[]): unknown[] => instances.map((i) => (i as Record<string, unknown>).name).sort();

  describe(`on_delete constraint conformance — ${formatPrefix}`, () => {
    it("refuses the deletion of the target of a mandatory relation by default, and removes nothing", async () => {
      const locator = newLocator();
      await setupOnDelete(locator);
      await runCommand(locator, { create: "team", input: [{ name: "t1" }] });
      await runCommand(locator, { create: "member", input: [{ name: "m1", team: "t1" }] });

      await expect(runCommand(locator, { delete: "team", filters: { name: "t1" } })).rejects.toMatchObject({ code: "constraint_violation" });
      expect(namesOf((await runCommand(locator, { query: "team" })).after)).toEqual(["t1"]);
      expect((await runCommand(locator, { query: "member" })).after[0]).toMatchObject({ name: "m1", team: "t1" });

      // once nothing references the team any more, the delete goes through
      await runCommand(locator, { delete: "member", filters: { name: "m1" } });
      await runCommand(locator, { delete: "team", filters: { name: "t1" } });
      expect((await runCommand(locator, { query: "team" })).after).toEqual([]);
    });

    it("refuses the deletion when the relation is declared restrict, whether it is mandatory or not", async () => {
      const locator = newLocator();
      await setupOnDelete(locator);
      await runCommand(locator, { create: "team", input: [{ name: "t1" }] });
      await runCommand(locator, { create: "tag", input: [{ name: "g1", team: "t1" }] });

      await expect(runCommand(locator, { delete: "team", filters: { name: "t1" } })).rejects.toMatchObject({ code: "constraint_violation" });
      expect(namesOf((await runCommand(locator, { query: "team" })).after)).toEqual(["t1"]);
    });

    it("deletes the instances of a cascade relation with the target and reports them in cascade-deleted", async () => {
      const locator = newLocator();
      await setupOnDelete(locator);
      await runCommand(locator, { create: "team", input: [{ name: "t1" }, { name: "t2" }] });
      await runCommand(locator, { create: "badge", input: [{ name: "b1", team: "t1" }, { name: "b2", team: "t2" }] });

      const result = await runCommand(locator, { delete: "team", filters: { name: "t1" } });
      expect(namesOf(result["cascade-deleted"])).toEqual(["b1"]);
      expect(namesOf((await runCommand(locator, { query: "badge" })).after)).toEqual(["b2"]);
      expect(namesOf((await runCommand(locator, { query: "team" })).after)).toEqual(["t2"]);
    });

    it("does not let an instance that the same delete removes block it", async () => {
      const locator = newLocator();
      await setupOnDelete(locator);
      await runCommand(locator, { create: "team", input: [{ name: "t1" }] });
      await runCommand(locator, { create: "badge", input: [{ name: "b1", team: "t1" }] });
      // p1 is owned by b1 and restricts the deletion of t1, but b1 goes with t1
      await runCommand(locator, { create: "pass", input: [{ name: "p1", badge: "b1", team: "t1" }] });

      const result = await runCommand(locator, { delete: "team", filters: { name: "t1" } });
      expect(namesOf(result["cascade-deleted"])).toEqual(["b1", "p1"]);
      expect((await runCommand(locator, { query: "pass" })).after).toEqual([]);
    });

    it("clears the relation of an optional relation without on_delete", async () => {
      const locator = newLocator();
      await setupOnDelete(locator);
      await runCommand(locator, { create: "team", input: [{ name: "t1" }] });
      await runCommand(locator, { create: "note", input: [{ name: "n1", team: "t1" }] });

      await runCommand(locator, { delete: "team", filters: { name: "t1" } });
      expect((await runCommand(locator, { query: "note" })).after[0]).toMatchObject({ name: "n1", team: null });
    });

    it("refuses a schema whose on_delete breaks the rules, with constraint_violation", async () => {
      const locator = newLocator();
      await initDataset(locator, "on-delete-reject");
      const upgradeLocator = await createUpgradeLocator(locator);
      await runCommand(upgradeLocator, { create: "schema", input: [onDeleteModel[0]] });
      const withProperty = (property: Record<string, unknown>) => ({
        create: "schema",
        input: [{ name: "link", shared_by_name: null, properties: [{ name: "name", type: "identifier" }, property] }],
      });

      // set_null on a mandatory relation
      await expect(
        runCommand(upgradeLocator, withProperty({ name: "team", type: "team", mandatory: null, on_delete: "set_null" })),
      ).rejects.toMatchObject({ code: "constraint_violation" });
      // on_delete on an owner relation
      await expect(
        runCommand(upgradeLocator, withProperty({ name: "team", type: "team", owner: null, on_delete: "cascade" })),
      ).rejects.toMatchObject({ code: "constraint_violation" });
      // a value that is not restrict, cascade or set_null
      await expect(
        runCommand(upgradeLocator, withProperty({ name: "team", type: "team", on_delete: "wipe" })),
      ).rejects.toMatchObject({ code: "constraint_violation" });
    });
  });

  describe(`map type conformance — ${formatPrefix}`, () => {
    it("stores the entries of a map, and gives an empty map to a property that was not given", async () => {
      const locator = newLocator();
      await setupLocalized(locator);

      await runCommand(locator, {
        create: "plant",
        input: [
          { name: "oak", display_name: { en: "Oak", fr: "Chêne" }, description: { en: "# Oak" }, synonyms: { fr: "Rouvre" } },
          { name: "fern", display_name: { en: "Fern" } },
        ],
      });

      const oak = (await runCommand(locator, { query: "plant", filters: { name: "oak" } })).after[0];
      expect(oak).toMatchObject({ display_name: { en: "Oak", fr: "Chêne" }, description: { en: "# Oak" }, synonyms: { fr: "Rouvre" } });
      const fern = (await runCommand(locator, { query: "plant", filters: { name: "fern" } })).after[0];
      expect(fern).toMatchObject({ display_name: { en: "Fern" }, description: {}, synonyms: {} });
    });

    it("refuses a key that is not a language code, a value that is not a string and a map under min_length", async () => {
      const locator = newLocator();
      await setupLocalized(locator);

      await expect(
        runCommand(locator, { create: "plant", input: [{ name: "a", display_name: { english: "Oak" } }] }),
      ).rejects.toMatchObject({ code: "constraint_violation" });
      await expect(runCommand(locator, { create: "plant", input: [{ name: "a", display_name: { en: 5 } }] })).rejects.toMatchObject({
        code: "constraint_violation",
      });
      await expect(runCommand(locator, { create: "plant", input: [{ name: "a" }] })).rejects.toMatchObject({ code: "constraint_violation" });
    });

    it("updates a map with set and remove, one language at a time, and refuses a malformed operand", async () => {
      const locator = newLocator();
      await setupLocalized(locator);
      await runCommand(locator, { create: "plant", input: [{ name: "oak", display_name: { en: "Oak", fr: "Chêne" } }] });

      const set = await runCommand(locator, { update: "plant", filters: { name: "oak" }, input: { display_name: { set: { fr: "Rouvre", de: "Eiche" } } } });
      expect(set.before[0]).toMatchObject({ display_name: { en: "Oak", fr: "Chêne" } });
      expect(set.after[0]).toMatchObject({ display_name: { en: "Oak", fr: "Rouvre", de: "Eiche" } });

      const removed = await runCommand(locator, { update: "plant", filters: { name: "oak" }, input: { display_name: { remove: ["fr", "es"] } } });
      expect(removed.after[0]).toMatchObject({ display_name: { en: "Oak", de: "Eiche" } });

      const stored = (await runCommand(locator, { query: "plant", filters: { name: "oak" } })).after[0] as Record<string, unknown>;
      expect(stored.display_name).toEqual({ en: "Oak", de: "Eiche" });

      await expect(
        runCommand(locator, { update: "plant", filters: { name: "oak" }, input: { display_name: { set: "fr" } } }),
      ).rejects.toMatchObject({ code: "invalid_map_operation" });
      await expect(
        runCommand(locator, { update: "plant", filters: { name: "oak" }, input: { display_name: { remove: ["en", "de"] } } }),
      ).rejects.toMatchObject({ code: "constraint_violation" });
    });

    it("filters on the entry of a map: an instance without the entry satisfies no predicate, ne included", async () => {
      const locator = newLocator();
      await setupLocalized(locator);
      await runCommand(locator, {
        create: "plant",
        input: [
          { name: "oak", display_name: { en: "Oak", fr: "Chêne" } },
          { name: "pine", display_name: { en: "Pine", fr: "Pin" } },
          { name: "fern", display_name: { en: "Fern" } },
        ],
      });
      const names = async (filters: Record<string, unknown>) =>
        ((await runCommand(locator, { query: "plant", filters })).after as Record<string, unknown>[]).map((p) => p.name).sort();

      expect(await names({ "display_name.fr": "Chêne" })).toEqual(["oak"]);
      expect(await names({ "display_name.fr": { matches: "^P" } })).toEqual(["pine"]);
      expect(await names({ "display_name.fr": { ne: "Chêne" } })).toEqual(["pine"]);
      expect(await names({ not: { "display_name.fr": "Chêne" } })).toEqual(["fern", "pine"]);
      expect(await names({ "synonyms": { exists: false } })).toEqual(["fern", "oak", "pine"]);
    });

    it.each(["json", "yaml"] as const)("dumpDataset/restoreDataset round-trips the maps (%s)", async (format) => {
      const locator = newLocator();
      await setupLocalized(locator);
      await runCommand(locator, {
        create: "plant",
        input: [{ name: "oak", display_name: { en: "Oak", fr: "Chêne" }, description: { fr: "# Chêne\n\nUn arbre." } }],
      });

      const restoreLocator = newLocator();
      await restoreDataset(restoreLocator, await dumpDataset(locator, format), format);

      const restored = (await runCommand(restoreLocator, { query: "plant", filters: { name: "oak" } })).after[0];
      expect(restored).toMatchObject({
        display_name: { en: "Oak", fr: "Chêne" },
        description: { fr: "# Chêne\n\nUn arbre." },
        synonyms: {},
      });
      const schema = (await runCommand(restoreLocator, { query: "schema", filters: { name: "plant" } })).after[0] as unknown as NormalizedSchema;
      expect(schema.properties.map((p) => [p.name, p.type])).toEqual(
        expect.arrayContaining([
          ["display_name", "localized_string"],
          ["description", "localized_markdown"],
          ["synonyms", "{language_code: string}"],
        ]),
      );
    });
  });

  describe(`model upgrade conformance — ${formatPrefix}`, () => {
    it("rejects a schema/scalar_type change against a locator that isn't an upgrade locator", async () => {
      const locator = newLocator();
      await setupTaskDemo(locator);
      await expect(runCommand(locator, { create: "schema", input: [{ name: "label", properties: [] }] })).rejects.toMatchObject({
        code: "not_upgrade_locator",
      });
      await expect(runCommand(locator, { create: "scalar_type", input: [{ name: "url", extends: "string" }] })).rejects.toMatchObject({
        code: "not_upgrade_locator",
      });
    });

    it("rejects a data change against an upgrade locator, but still allows a query (an empty store, not an error)", async () => {
      const locator = newLocator();
      await setupTaskDemo(locator);
      const upgradeLocator = await createUpgradeLocator(locator);
      await expect(
        runCommand(upgradeLocator, { create: "person", input: [{ name: "nope", email: "nope@example.com" }] }),
      ).rejects.toMatchObject({ code: "upgrade_locator" });
      const queried = await runCommand(upgradeLocator, { kind: "query", schema: "person" });
      expect(queried.after).toEqual([]);
    });

    it("scalar_type is create-only — update and delete are rejected with constraint_violation", async () => {
      const locator = newLocator();
      await setupTaskDemo(locator);
      const upgradeLocator = await createUpgradeLocator(locator);
      await expect(
        runCommand(upgradeLocator, { kind: "update", schema: "scalar_type", filters: { name: "task_status" }, input: [{ enum: ["x"] }] }),
      ).rejects.toMatchObject({ code: "constraint_violation" });
      await expect(runCommand(upgradeLocator, { kind: "delete", schema: "scalar_type", filters: { name: "task_status" } })).rejects.toMatchObject({
        code: "constraint_violation",
      });
    });

    it("createUpgradeLocator rejects a missing dataset; queryUpgradeLocator/checkUpgrade/upgradeDataset reject a locator that isn't (this dataset's) upgrade locator", async () => {
      const locator = newLocator();
      await expect(createUpgradeLocator(locator)).rejects.toMatchObject({ code: "dataset_not_found" });

      await setupTaskDemo(locator);
      await expect(queryUpgradeLocator(locator)).rejects.toMatchObject({ code: "not_upgrade_locator" }); // a real dataset, not an upgrade locator

      const otherLocator = newLocator();
      await setupTaskDemo(otherLocator);
      await expect(checkUpgrade(locator, otherLocator)).rejects.toMatchObject({ code: "not_upgrade_locator" });
      await expect(upgradeDataset(locator, otherLocator)).rejects.toMatchObject({ code: "not_upgrade_locator" });
    });

    it("adds a schema through an upgrade locator; queryUpgradeLocator reports it, upgradeDataset applies it bumping model_minor_version only", async () => {
      const locator = newLocator();
      await setupTaskDemo(locator);
      const before = (await queryDataset(locator)) as Record<string, unknown>;

      const upgradeLocator = await createUpgradeLocator(locator);
      await runCommand(upgradeLocator, {
        create: "schema",
        input: [{ name: "label", shared_by_name: null, properties: [{ name: "name", type: "identifier" }] }],
      });

      const { source_locator, namespace, commandResult } = await queryUpgradeLocator(upgradeLocator);
      expect(source_locator).toBe(locator);
      expect(namespace).toBe("");
      expect(commandResult.before).toEqual([]);
      expect((commandResult.after as Record<string, unknown>[]).map((s) => s.name)).toContain("label");

      const check = await checkUpgrade(locator, upgradeLocator);
      expect(check).toEqual({ autoUpdate: [], modifiedSchema: [], lostSchema: [] }); // no existing data touched by a brand new schema

      const result = await upgradeDataset(locator, upgradeLocator);
      expect(result.before).toEqual([]);
      expect(result.after).toEqual([]); // no data instances to backfill for a brand new schema

      const after = (await queryDataset(locator)) as Record<string, unknown>;
      expect(after.schemas).toContain("label");
      expect(after.model_minor_version).toBe((before.model_minor_version as number) + 1);
      expect(after.data_minor_version).toBe(before.data_minor_version); // untouched

      const created = await runCommand(locator, { create: "label", input: [{ name: "urgent" }] });
      expect(created.after).toHaveLength(1);
    });

    /**
     * A `${...}` in a schema's `default_value` belongs to the instances that
     * schema will later build — packages/core/docs/spec/model-command-language.md#schema-processing
     * leaves it a literal string through normalization, and
     * packages/core/docs/spec/meta-model.md#placeholders resolves it at construction
     * time. A script's own placeholder pass, which runs over an ordinary
     * command's input, has to leave a model command's input alone for that to
     * hold: `this` doesn't exist yet at that point.
     */
    it("keeps a placeholder in a schema's default_value literal through a script, and resolves it at instance construction", async () => {
      const locator = newLocator();
      await initDataset(locator, "cards");
      const upgradeLocator = await createUpgradeLocator(locator);
      await runScript(upgradeLocator, {
        commands: [
          {
            kind: "create",
            schema: "schema",
            input: [
              {
                name: "card",
                shared_by_name: null,
                properties: [
                  { name: "name", type: "identifier" },
                  { name: "display_name", type: "string" },
                  { name: "title", type: "string", default_value: "${this.display_name}" },
                ],
              },
            ],
          },
        ],
      });
      await upgradeDataset(locator, upgradeLocator);

      const stored = (await runCommand(locator, { query: "schema", filters: { name: "card" } })).after[0] as unknown as NormalizedSchema;
      expect(stored.properties.find((p) => p.name === "title")?.default_value).toBe("${this.display_name}");

      const created = await runCommand(locator, { create: "card", input: [{ name: "c1", display_name: "Hello" }] });
      expect((created.after[0] as Record<string, unknown>).title).toBe("Hello");
    });

    /**
     * `this.schema` is one of the roots packages/core/docs/spec/meta-model.md#placeholders
     * names, reaching the schema of the instance under construction. A schema's
     * own `content` (packages/core/docs/spec/meta-model.md#schema) is therefore usable as
     * the starting content of every instance that schema builds, and an
     * explicit value given at creation still wins over it.
     */
    it("resolves ${this.schema.content} at construction, seeding an instance from its schema's own content", async () => {
      const locator = newLocator();
      await initDataset(locator, "notes");
      const upgradeLocator = await createUpgradeLocator(locator);
      await runCommand(upgradeLocator, {
        create: "schema",
        input: [
          {
            name: "note",
            shared_by_name: null,
            content: "## Notes\n",
            properties: [
              { name: "name", type: "identifier" },
              { name: "body", type: "markdown", is_content: null, default_value: "${this.schema.content}" },
            ],
          },
        ],
      });
      await upgradeDataset(locator, upgradeLocator);

      const stored = (await runCommand(locator, { query: "schema", filters: { name: "note" } })).after[0] as unknown as NormalizedSchema;
      expect(stored.content).toBe("## Notes\n");

      const seeded = await runCommand(locator, { create: "note", input: [{ name: "n1" }] });
      expect((seeded.after[0] as Record<string, unknown>).body).toBe("## Notes\n");

      const given = await runCommand(locator, { create: "note", input: [{ name: "n2", body: "its own body" }] });
      expect((given.after[0] as Record<string, unknown>).body).toBe("its own body");
    });

    it("checkUpgrade classifies a compatible property addition as autoUpdate, and upgradeDataset backfills existing instances", async () => {
      const locator = newLocator();
      await setupTaskDemo(locator);
      await runCommand(locator, {
        create: "person",
        input: [
          { name: "alice", email: "alice@example.com" },
          { name: "bob", email: "bob@example.com" },
        ],
      });

      const upgradeLocator = await createUpgradeLocator(locator);
      await runCommand(upgradeLocator, {
        kind: "update",
        schema: "schema",
        filters: { name: "person" },
        input: [
          {
            name: "person",
            shared_by_name: null,
            properties: [
              { name: "name", type: "identifier" },
              { name: "email", type: "email" },
              { name: "nickname", type: "string", default_value: "unknown" },
            ],
          },
        ],
      });

      const check = await checkUpgrade(locator, upgradeLocator);
      expect(check.autoUpdate).toHaveLength(2);
      expect(check.modifiedSchema).toEqual([]);
      expect(check.lostSchema).toEqual([]);

      const result = await upgradeDataset(locator, upgradeLocator);
      expect(result.before).toHaveLength(2);
      expect(result.after).toHaveLength(2);
      for (const p of result.after as Record<string, unknown>[]) expect(p.nickname).toBe("unknown");

      const requeried = await runCommand(locator, { kind: "query", schema: "person", filters: { name: "alice" } });
      expect((requeried.after[0] as Record<string, unknown>).nickname).toBe("unknown");
      // the virtual inverse property from task.assignee's inverse_name survives the update untouched
      expect((requeried.after[0] as Record<string, unknown>).assigned_tasks).toEqual([]);

      const after = (await queryDataset(locator)) as Record<string, unknown>;
      expect(after.data_minor_version).toBeGreaterThan(0);
    });

    it("checkUpgrade classifies an incompatible mandatory-relation addition as modifiedSchema, and upgradeDataset rejects with incompatible_upgrade, applying nothing", async () => {
      const locator = newLocator();
      await setupTaskDemo(locator);
      await runCommand(locator, { create: "person", input: [{ name: "carol", email: "carol@example.com" }] });
      const personSchemaBefore = await runCommand(locator, { kind: "query", schema: "schema", filters: { name: "person" } });

      const upgradeLocator = await createUpgradeLocator(locator);
      await runCommand(upgradeLocator, {
        kind: "update",
        schema: "schema",
        filters: { name: "person" },
        input: [
          {
            name: "person",
            shared_by_name: null,
            properties: [
              { name: "name", type: "identifier" },
              { name: "email", type: "email" },
              { name: "primary_task", type: "task", mandatory: null },
            ],
          },
        ],
      });

      const check = await checkUpgrade(locator, upgradeLocator);
      expect(check.modifiedSchema).toHaveLength(1);
      expect(check.autoUpdate).toEqual([]);

      await expect(upgradeDataset(locator, upgradeLocator)).rejects.toMatchObject({ code: "incompatible_upgrade" });

      const personSchemaAfter = await runCommand(locator, { kind: "query", schema: "schema", filters: { name: "person" } });
      expect(personSchemaAfter.after).toEqual(personSchemaBefore.after); // rejected outright, nothing applied
    });

    it("deleting a schema is reflected in lostSchema for its own instances, and cascades (\"considered as deleted\") to a schema extending it", async () => {
      const locator = newLocator();
      await initDataset(locator, "extends-demo");
      const seedLocator = await createUpgradeLocator(locator);
      await runCommand(seedLocator, {
        create: "schema",
        input: [{ name: "base_item", shared_by_name: null, properties: [{ name: "name", type: "identifier" }] }],
      });
      await runCommand(seedLocator, { create: "schema", input: [{ name: "special_item", extends: "base_item", properties: [] }] });
      await upgradeDataset(locator, seedLocator);

      await runCommand(locator, { create: "base_item", input: [{ name: "b1" }] });
      await runCommand(locator, { create: "special_item", input: [{ name: "s1" }] });

      const upgradeLocator = await createUpgradeLocator(locator);
      await runCommand(upgradeLocator, { kind: "delete", schema: "schema", filters: { name: "base_item" } });

      const { commandResult } = await queryUpgradeLocator(upgradeLocator);
      expect((commandResult.before as Record<string, unknown>[]).map((s) => s.name)).toContain("base_item");
      expect((commandResult["cascade-deleted"] as Record<string, unknown>[]).map((s) => s.name)).toContain("special_item");

      const check = await checkUpgrade(locator, upgradeLocator);
      const lostNames = (check.lostSchema as Record<string, unknown>[]).map((i) => i.name).sort();
      expect(lostNames).toEqual(["b1", "s1"]);
    });
  });

  /**
   * TDD red state for "Avoid physically copying built-in schemas/scalars
   * into each dataset" — replaces the
   * copy-at-init / standing-import design these tests originally proved out.
   * Under the new design: `initDataset` never creates an import or copies
   * anything; every read of a dataset's own schema/scalar_type overlays the
   * area's built-in dataset live via `builtinRestFor`; `dumpDataset`
   * synthesizes a `namespace: ""` import recording only the built-in's
   * version (no schema/scalar_type content); `restoreDataset` uses that
   * synthesized entry to check/upgrade restored data against the *current*
   * built-in model, then discards it — the restored dataset never gets a
   * standing import either. See packages/core/docs/spec/meta-model.md#import's
   * "Built-in — virtual, not imported" and
   * `docs/datasets.md` of `@scfloworg/core`:
   * Lifecycle, and Schemas and the built-in dataset.
   *
   * Engine-level (api.ts), so this belongs in the shared suite rather than a
   * per-format test: any conforming format proves it out just by implementing
   * `areaOf`/`builtinRestFor` correctly, already done for both `js` and
   * `obsidian`.
   *
   * These are written against the *new* behaviour and are expected to fail
   * against today's `createBuiltinImport`/`realignBuiltinImport`
   * implementation — that is deliberate: tests land first, implementation
   * follows.
   *
   * `newAreaRest`/`newAreaLocator` give each test its own independent area —
   * plain `newLocator()` above can't: every locator it generates is flat (no
   * "/"), so `builtinRestFor` resolves to the exact same single rest for the
   * *entire* conformance run for a given format+impl instance (`js`'s `areaOf`
   * is "" for any flat rest; `obsidian`'s is always this file's shared
   * `baseDir`). Embedding a synthetic area segment first (`<tag>/rest...`)
   * gives each test a private area under both formats' actual conventions,
   * without this suite needing to know either one specifically.
   */
  describe(`built-in import conformance — ${formatPrefix}`, () => {
    let areaCounter = 0;
    // A tag maps to the same area prefix every time — the trailing
    // "conformance-..." segment still gets a fresh value per call, but the
    // "built-in-<tag>-N" prefix, and so the area, is fixed the first time a
    // given tag is seen.
    const areaTags = new Map<string, string>();
    function newAreaRest(tag: string): string {
      let areaTag = areaTags.get(tag);
      if (!areaTag) {
        areaCounter += 1;
        areaTag = `built-in-${tag}-${areaCounter}`;
        areaTags.set(tag, areaTag);
      }
      counter += 1;
      return `${areaTag}/conformance-${Date.now()}-${counter}`;
    }
    function newAreaLocator(tag: string): string {
      return `${formatPrefix}:${newAreaRest(tag)}`;
    }

    /** Creates a fresh built-in dataset in a new area: schema `widget`, schema `gadget` (nothing ever instantiates it — free to delete in a realignment test), scalar_type `flag`. */
    async function seedBuiltinDataset(tag: string): Promise<{ builtinRest: string; builtinLocator: string }> {
      const builtinRest = impl.builtinRestFor(newAreaRest(tag)) as string;
      await impl.createDataset(builtinRest, "Builtin");
      const schemas = new Map<string, NormalizedSchema>();
      const ctx = { resolveSchema: (n: string) => schemas.get(n), resolveScalarType: () => undefined };
      const widget = processSchemaDescription({ name: "widget", is_root: true, properties: [{ name: "label", type: "string" }] }, ctx);
      schemas.set("widget", widget);
      await impl.putInstance(builtinRest, "schema", "widget", widget as unknown as TransientValue, NO_ROLES);
      const gadget = processSchemaDescription({ name: "gadget", is_root: true, properties: [{ name: "note", type: "string" }] }, ctx);
      schemas.set("gadget", gadget);
      await impl.putInstance(builtinRest, "schema", "gadget", gadget as unknown as TransientValue, NO_ROLES);
      const flag = processScalarTypeDescription({ name: "flag", extends: "boolean" }, ctx.resolveScalarType);
      await impl.putInstance(builtinRest, "scalar_type", "flag", flag as unknown as TransientValue, NO_ROLES);
      return { builtinRest, builtinLocator: `${formatPrefix}:${builtinRest}` };
    }

    it("initDataset leaves schemas/scalar_types/imports empty when the area has no built-in dataset yet", async () => {
      const locator = newAreaLocator("empty");
      await initDataset(locator, "no-builtin-yet");
      const found = (await queryDataset(locator)) as Record<string, unknown>;
      expect(found.schemas).toEqual([]);
      expect(found.scalar_types).toEqual([]);
      expect(found.imports).toEqual([]);
    });

    it("initDataset creates no import and copies nothing, but the built-in's schemas/scalar_types are transparently visible and usable", async () => {
      const tag = "basic";
      const { builtinRest } = await seedBuiltinDataset(tag);
      const consumerRest = newAreaRest(tag);
      const locator = `${formatPrefix}:${consumerRest}`;
      await initDataset(locator, "consumer");

      // Visible through the dataset's own query surface, unprefixed, as if imported...
      const found = (await queryDataset(locator)) as Record<string, unknown>;
      expect((found.schemas as string[]).sort()).toEqual(["gadget", "widget"]);
      expect(found.scalar_types).toEqual(["flag"]);
      // ...but NOT via a standing import: none was created.
      expect(found.imports).toEqual([]);

      // Nothing was physically copied into the consumer dataset's own storage.
      expect(await impl.listInstances(consumerRest, "schema", NO_ROLES)).toEqual([]);
      expect(await impl.listInstances(consumerRest, "scalar_type", NO_ROLES)).toEqual([]);
      expect(await impl.listInstances(consumerRest, "import", NO_ROLES)).toEqual([]);

      // Genuinely usable through the real engine even though it was never created against `locator`.
      const created = await runCommand(locator, { create: "widget", input: [{ label: "hello" }] });
      expect(created.after).toHaveLength(1);
      expect((created.after[0] as Record<string, unknown>).label).toBe("hello");

      // A dataset in a DIFFERENT area doesn't see this area's built-in.
      const otherLocator = newAreaLocator("basic-unrelated");
      await initDataset(otherLocator, "unrelated");
      const otherFound = (await queryDataset(otherLocator)) as Record<string, unknown>;
      expect(otherFound.schemas).toEqual([]);

      expect(await impl.datasetExists(builtinRest)).toBe(true); // sanity: still there, untouched
    });

    it("query: schema / query: scalar_type include the built-in's instances, not just the dataset's own", async () => {
      const tag = "query-overlay";
      await seedBuiltinDataset(tag);
      const consumerRest = newAreaRest(tag);
      const locator = `${formatPrefix}:${consumerRest}`;
      await initDataset(locator, "consumer");

      const schemaQuery = await runCommand(locator, { query: "schema" });
      expect((schemaQuery.after as Record<string, unknown>[]).map((s) => s.name).sort()).toEqual(["gadget", "widget"]);

      const scalarQuery = await runCommand(locator, { query: "scalar_type" });
      expect((scalarQuery.after as Record<string, unknown>[]).map((s) => s.name)).toEqual(["flag"]);

      // Filters apply across the merged (own + overlay) result too.
      const filtered = await runCommand(locator, { query: "schema", filters: { name: "widget" } });
      expect(filtered.after).toHaveLength(1);
      expect((filtered.after[0] as Record<string, unknown>).name).toBe("widget");
    });

    it("query: schema merges the built-in's instances with a dataset's own schema", async () => {
      const tag = "query-overlay-own";
      await seedBuiltinDataset(tag);
      const consumerRest = newAreaRest(tag);
      const locator = `${formatPrefix}:${consumerRest}`;
      await initDataset(locator, "consumer");

      const upgradeLocator = await createUpgradeLocator(locator);
      await runCommand(upgradeLocator, {
        create: "schema",
        input: [{ name: "gizmo", is_root: true, properties: [{ name: "note", type: "string" }] }],
      });
      await upgradeDataset(locator, upgradeLocator);

      const schemaQuery = await runCommand(locator, { query: "schema" });
      expect((schemaQuery.after as Record<string, unknown>[]).map((s) => s.name).sort()).toEqual(["gadget", "gizmo", "widget"]);
    });

    it("a dataset's schema overlay tracks the built-in live, with no explicit realignment step", async () => {
      const tag = "live-overlay";
      await seedBuiltinDataset(tag);
      const consumerRest = newAreaRest(tag);
      const locator = `${formatPrefix}:${consumerRest}`;
      await initDataset(locator, "consumer");

      const before = (await queryDataset(locator)) as Record<string, unknown>;
      expect((before.schemas as string[]).sort()).toEqual(["gadget", "widget"]);

      // Change the built-in AFTER the consumer dataset exists — no dump/restore, no explicit realign call.
      const builtinLocator = `${formatPrefix}:${impl.builtinRestFor(consumerRest)}`;
      const upgradeLocator = await createUpgradeLocator(builtinLocator);
      await runCommand(upgradeLocator, {
        create: "schema",
        input: [{ name: "extra", is_root: null, properties: [{ name: "n", type: "string" }] }],
      });
      await upgradeDataset(builtinLocator, upgradeLocator);

      // The consumer sees it immediately, on the very next read.
      const after = (await queryDataset(locator)) as Record<string, unknown>;
      expect((after.schemas as string[]).sort()).toEqual(["extra", "gadget", "widget"]);
      const created = await runCommand(locator, { create: "extra", input: [{ n: "x" }] });
      expect(created.after).toHaveLength(1);
    });

    it("dumpDataset synthesizes a bookkeeping-only built-in import, without copying its schemas/scalar_types into the dump", async () => {
      const tag = "dump";
      const { builtinRest, builtinLocator } = await seedBuiltinDataset(tag);
      const consumerRest = newAreaRest(tag);
      const locator = `${formatPrefix}:${consumerRest}`;
      await initDataset(locator, "consumer");

      const dump = await dumpDataset(locator, "json");
      const parsed = JSON.parse(dump) as Record<string, unknown>;

      const imports = parsed.imports as Record<string, Record<string, unknown>>;
      expect(Object.keys(imports)).toEqual(["builtin"]);
      const builtinImport = imports.builtin;
      expect(builtinImport).toMatchObject({ namespace: "", caching_policy: "none", locator: builtinLocator });
      expect(typeof builtinImport.model_major_version).toBe("number");
      expect(typeof builtinImport.model_minor_version).toBe("number");
      expect((builtinImport.imported_schemas as string[]).sort()).toEqual(["gadget", "widget"]);
      expect(builtinImport.imported_scalar_types).toEqual(["flag"]);

      // Bookkeeping only — no schema/scalar_type CONTENT copied into the dump.
      const schemas = parsed.schemas as Record<string, unknown>;
      const scalarTypes = parsed.scalar_types as Record<string, unknown>;
      expect(Object.keys(schemas)).toEqual([]);
      expect(Object.keys(scalarTypes)).toEqual([]);

      expect(await impl.datasetExists(builtinRest)).toBe(true); // sanity: still there, untouched
    });

    it("restoreDataset installs no standing built-in import; the restored dataset overlays the built-in live and its own data survives", async () => {
      const tag = "restore-basic";
      await seedBuiltinDataset(tag);
      const consumerRest = newAreaRest(tag);
      const locator = `${formatPrefix}:${consumerRest}`;
      await initDataset(locator, "consumer");
      const createdBefore = await runCommand(locator, { create: "widget", input: [{ label: "hello" }] });
      const widgetKey = (createdBefore.after[0] as Record<string, unknown>).id as string;
      const dump = await dumpDataset(locator, "json");

      const restoreRest = newAreaRest(tag); // same area (same tag) as the original
      const restoreLocator = `${formatPrefix}:${restoreRest}`;
      const result = await restoreDataset(restoreLocator, dump, "json");
      expect(result.pendingRealignment).toEqual([]);

      expect(await impl.listInstances(restoreRest, "import", NO_ROLES)).toEqual([]);
      expect(await impl.listInstances(restoreRest, "schema", NO_ROLES)).toEqual([]);

      const restored = (await queryDataset(restoreLocator)) as Record<string, unknown>;
      expect((restored.schemas as string[]).sort()).toEqual(["gadget", "widget"]);
      expect(restored.imports).toEqual([]);

      const queried = await runCommand(restoreLocator, { query: "widget", filters: { id: widgetKey } });
      expect(queried.after).toHaveLength(1);
      expect((queried.after[0] as Record<string, unknown>).label).toBe("hello");

      const createdAfter = await runCommand(restoreLocator, { create: "widget", input: [{ label: "second" }] });
      expect(createdAfter.after).toHaveLength(1);
    });

    it("restoreDataset upgrades restored data against the built-in's CURRENT model when it changed since the dump", async () => {
      const tag = "restore-upgrade";
      const { builtinLocator } = await seedBuiltinDataset(tag);
      const consumerRest = newAreaRest(tag);
      const locator = `${formatPrefix}:${consumerRest}`;
      await initDataset(locator, "consumer");
      const createdBefore = await runCommand(locator, { create: "widget", input: [{ label: "hello" }] });
      const widgetKey = (createdBefore.after[0] as Record<string, unknown>).id as string;
      const dump = await dumpDataset(locator, "json");

      // Built-in's widget gains a property with a default value AFTER the dump was taken.
      const upgradeLocator = await createUpgradeLocator(builtinLocator);
      await runCommand(upgradeLocator, {
        kind: "update",
        schema: "schema",
        filters: { name: "widget" },
        input: [
          {
            name: "widget",
            is_root: null,
            properties: [
              { name: "label", type: "string" },
              { name: "note", type: "string", default_value: "n/a" },
            ],
          },
        ],
      });
      await upgradeDataset(builtinLocator, upgradeLocator);

      const restoreLocator = newAreaLocator(tag);
      await restoreDataset(restoreLocator, dump, "json");

      const queried = await runCommand(restoreLocator, { query: "widget", filters: { id: widgetKey } });
      expect(queried.after).toHaveLength(1);
      expect((queried.after[0] as Record<string, unknown>).note).toBe("n/a"); // backfilled against the CURRENT built-in model
    });

    it("restoreDataset throws incompatible_upgrade when the built-in's change since the dump can't be applied automatically to restored data", async () => {
      const tag = "restore-incompatible";
      const { builtinLocator } = await seedBuiltinDataset(tag);
      const consumerRest = newAreaRest(tag);
      const locator = `${formatPrefix}:${consumerRest}`;
      await initDataset(locator, "consumer");
      await runCommand(locator, { create: "widget", input: [{ label: "existing" }] });
      const dump = await dumpDataset(locator, "json");

      const seedLocator = await createUpgradeLocator(builtinLocator);
      await runCommand(seedLocator, {
        create: "schema",
        input: [{ name: "owner_ref", shared_by_name: null, properties: [{ name: "name", type: "identifier" }] }],
      });
      await upgradeDataset(builtinLocator, seedLocator);

      // widget.label stays, but widget gains a MANDATORY relation with no default — no
      // existing "widget" instance in the dump has a value for it, so restoring can't
      // apply the built-in's current model automatically.
      const upgradeLocator = await createUpgradeLocator(builtinLocator);
      await runCommand(upgradeLocator, {
        kind: "update",
        schema: "schema",
        filters: { name: "widget" },
        input: [
          {
            name: "widget",
            is_root: null,
            properties: [
              { name: "label", type: "string" },
              { name: "owner", type: "owner_ref", mandatory: true },
            ],
          },
        ],
      });
      await upgradeDataset(builtinLocator, upgradeLocator);

      const restoreRest = newAreaRest(tag);
      await expect(restoreDataset(`${formatPrefix}:${restoreRest}`, dump, "json")).rejects.toMatchObject({ code: "incompatible_upgrade" });
      // A failed restore creates nothing at the locator.
      expect(await impl.datasetExists(restoreRest)).toBe(false);
    });

    it("builtinRestFor returns a rest for every rest", () => {
      expect(typeof impl.builtinRestFor(newAreaRest("builtin-rest"))).toBe("string");
      expect(typeof impl.builtinRestFor(newLocator().slice(formatPrefix.length + 1))).toBe("string");
    });

    it("dumpDataset writes the built-in import's four versions as 0, whatever the built-in's own versions", async () => {
      const tag = "dump-versions";
      const { builtinLocator } = await seedBuiltinDataset(tag);
      const upgradeLocator = await createUpgradeLocator(builtinLocator);
      await runCommand(upgradeLocator, {
        create: "schema",
        input: [{ name: "extra", is_root: null, properties: [{ name: "n", type: "string" }] }],
      });
      await upgradeDataset(builtinLocator, upgradeLocator);
      const builtinInfo = (await queryDataset(builtinLocator)) as Record<string, unknown>;
      expect(builtinInfo.model_minor_version).not.toBe(0); // the built-in's own version moved

      const locator = newAreaLocator(tag);
      await initDataset(locator, "consumer");
      const parsed = JSON.parse(await dumpDataset(locator, "json")) as Record<string, unknown>;
      const builtinImport = (parsed.imports as Record<string, Record<string, unknown>>).builtin;
      expect(builtinImport).toMatchObject({
        model_major_version: 0,
        model_minor_version: 0,
        data_major_version: 0,
        data_minor_version: 0,
      });
    });

    it("restoreDataset checks every restored built-in instance, even when the dump's built-in versions match, and creates nothing on failure", async () => {
      const tag = "restore-check-always";
      const { builtinRest } = await seedBuiltinDataset(tag);
      const ctx = { resolveSchema: () => undefined, resolveScalarType: () => undefined };
      const level = processScalarTypeDescription({ name: "level", extends: "string", enum: ["low", "high"] }, ctx.resolveScalarType);
      await impl.putInstance(builtinRest, "scalar_type", "level", level as unknown as TransientValue, NO_ROLES);
      const levelCtx = { resolveSchema: () => undefined, resolveScalarType: (n: string) => (n === "level" ? level : undefined) };
      const gauge = processSchemaDescription({ name: "gauge", is_root: true, properties: [{ name: "level", type: "level" }] }, levelCtx);
      await impl.putInstance(builtinRest, "schema", "gauge", gauge as unknown as TransientValue, NO_ROLES);

      const locator = newAreaLocator(tag);
      await initDataset(locator, "consumer");
      const created = await runCommand(locator, { create: "gauge", input: [{ level: "low" }] });
      const gaugeKey = (created.after[0] as Record<string, unknown>).id as string;

      const parsed = JSON.parse(await dumpDataset(locator, "json")) as Record<string, Record<string, Record<string, unknown>>>;
      // The built-in has not moved since the dump; the dumped instance itself no longer fits its schema.
      (parsed.data.gauge[gaugeKey] as Record<string, unknown>).level = "medium";

      const restoreRest = newAreaRest(tag);
      await expect(restoreDataset(`${formatPrefix}:${restoreRest}`, JSON.stringify(parsed), "json")).rejects.toMatchObject({
        code: "incompatible_upgrade",
      });
      expect(await impl.datasetExists(restoreRest)).toBe(false);
    });

    it("restoreDataset keeps an instance of a missing schema dormant: hidden from commands, dumped back unchanged", async () => {
      const tag = "dormant";
      const { builtinLocator } = await seedBuiltinDataset(tag);
      const locator = newAreaLocator(tag);
      await initDataset(locator, "consumer");
      await runCommand(locator, { create: "widget", input: [{ label: "hello" }] });

      const parsed = JSON.parse(await dumpDataset(locator, "json")) as Record<string, Record<string, unknown>>;
      const ghost = { id: "g1", note: "boo" };
      // Written while a contributor of "ghost" was installed, restored without it.
      parsed.data.ghost = { g1: ghost };

      const restoreLocator = newAreaLocator(tag);
      const result = await restoreDataset(restoreLocator, JSON.stringify(parsed), "json");
      expect(result.pendingRealignment).toEqual([]);

      // Not visible to commands; the rest of the dataset works as usual.
      await expect(runCommand(restoreLocator, { query: "ghost" })).rejects.toBeTruthy();
      expect((await runCommand(restoreLocator, { query: "widget" })).after).toHaveLength(1);
      expect(((await queryDataset(restoreLocator)) as Record<string, unknown>).schemas).not.toContain("ghost");

      // Written back unchanged, and kept through a second round trip.
      const redumped = JSON.parse(await dumpDataset(restoreLocator, "json")) as Record<string, Record<string, unknown>>;
      expect(redumped.data.ghost).toEqual({ g1: ghost });
      const secondLocator = newAreaLocator(tag);
      await restoreDataset(secondLocator, JSON.stringify(redumped), "json");
      const reredumped = JSON.parse(await dumpDataset(secondLocator, "json")) as Record<string, Record<string, unknown>>;
      expect(reredumped.data.ghost).toEqual({ g1: ghost });

      // Once its schema is available again, the dormant instance is an ordinary one.
      const upgradeLocator = await createUpgradeLocator(builtinLocator);
      await runCommand(upgradeLocator, {
        create: "schema",
        input: [{ name: "ghost", is_root: null, properties: [{ name: "note", type: "string" }] }],
      });
      await upgradeDataset(builtinLocator, upgradeLocator);
      const queried = await runCommand(restoreLocator, { query: "ghost" });
      expect(queried.after).toHaveLength(1);
      expect(queried.after[0]).toMatchObject({ id: "g1", note: "boo" });
      const finalDump = JSON.parse(await dumpDataset(restoreLocator, "json")) as Record<string, Record<string, unknown>>;
      expect(finalDump.data.ghost).toEqual({ g1: ghost });
    });

    it("rejects an invalid dataset name", async () => {
      const tag = "dataset-name-validation";
      const builtinRest = impl.builtinRestFor(newAreaRest(tag)) as string;
      await impl.createDataset(builtinRest, "Builtin");
      const ctx = { resolveSchema: () => undefined, resolveScalarType: () => undefined };
      const identifier = processScalarTypeDescription(
        { name: "identifier", extends: "string", pattern: "^[A-Za-z_][A-Za-z0-9_]*$" },
        ctx.resolveScalarType,
      );
      await impl.putInstance(builtinRest, "scalar_type", "identifier", identifier as unknown as TransientValue, NO_ROLES);

      const locator = newAreaLocator(tag);
      await initDataset(locator, "original");

      await expect(runCommand(locator, { kind: "update", schema: "dataset", input: { name: "" } })).rejects.toMatchObject({
        code: "constraint_violation",
      });
      await expect(runCommand(locator, { kind: "update", schema: "dataset", input: { name: "two words" } })).rejects.toMatchObject({
        code: "constraint_violation",
      });

      const dataset = await queryDataset(locator);
      expect((dataset as Record<string, unknown>).name).toBe("original");
    });
  });

  /**
   * Modules and names, per the Module, Names and The Core Module parts of
   * packages/core/docs/spec/meta-model.md. A manifest and a set of modules
   * live in the engine, apart from any dataset, so these cases run the same
   * for every format.
   */
  describe(`module conformance — ${formatPrefix}`, () => {
    const scflow = `
name: scflow:core
namespace: scflow
version: 1.3.0
mcl: ^1.0
title: Supply chain flow
scalar_types:
  - name: code
    extends: string
    pattern: '^[A-Z]{3}$'
schemas:
  - name: actor
    shared_by_name:
    properties:
      - name: name
        type: identifier
      - name: code
        type: code
      - name: founded
        type: date
actions:
  - id: scflow/create_actor
    title: Create an actor
`;
    const carbon = `
name: acme:carbon
namespace: carbon
version: 1.2.0
mcl: ^1.0
title: Carbon footprint
dependencies:
  - module: scflow:core
    version: ^1.3
schemas:
  - name: site
    extends: scflow.actor
    properties:
      - name: co2
        type: number
`;

    it("reads a manifest as an instance of the module schema", () => {
      const manifest = readModuleManifest(carbon);
      expect(manifest).toMatchObject({
        name: "acme:carbon",
        namespace: "carbon",
        version: "1.2.0",
        mcl: "^1.0",
        title: "Carbon footprint",
        dependencies: [{ module: "scflow:core", version: "^1.3" }],
      });
      expect(manifest.schemas.map((s) => s.name)).toEqual(["site"]);
    });

    it("refuses a manifest that breaks the module schema", () => {
      const refused = (text: string) => expect(() => readModuleManifest(text)).toThrow(expect.objectContaining({ code: "constraint_violation" }));
      // the key is publisher:module
      refused("name: carbon\nnamespace: carbon\nversion: 1.0.0\nmcl: ^1.0\n");
      // the namespace is an identifier, and every module has one
      refused("name: acme:carbon\nversion: 1.0.0\nmcl: ^1.0\n");
      refused("name: acme:carbon\nnamespace: acme.carbon\nversion: 1.0.0\nmcl: ^1.0\n");
      // a semantic version, and a range of mcl:core
      refused("name: acme:carbon\nnamespace: carbon\nversion: '1.0'\nmcl: ^1.0\n");
      refused("name: acme:carbon\nnamespace: carbon\nversion: 1.0.0\n");
      // a property the module schema does not declare
      refused("name: acme:carbon\nnamespace: carbon\nversion: 1.0.0\nmcl: ^1.0\nauthor: me\n");
      // mcl:core is given by `mcl`, never listed in the dependencies
      refused("name: acme:carbon\nnamespace: carbon\nversion: 1.0.0\nmcl: ^1.0\ndependencies:\n  - module: mcl:core\n    version: ^1.0\n");
      // the name of a schema is a short name
      refused("name: acme:carbon\nnamespace: carbon\nversion: 1.0.0\nmcl: ^1.0\nschemas:\n  - name: carbon.site\n");
      // the prefix of an action id is the namespace of its module
      refused("name: acme:carbon\nnamespace: carbon\nversion: 1.0.0\nmcl: ^1.0\nactions:\n  - id: scflow/create_site\n");
    });

    it("keeps names unique in their module", () => {
      expect(() =>
        readModuleManifest("name: acme:carbon\nnamespace: carbon\nversion: 1.0.0\nmcl: ^1.0\nschemas:\n  - name: site\n  - name: site\n"),
      ).toThrow(expect.objectContaining({ code: "duplicate_name" }));
      expect(() =>
        readModuleManifest("name: acme:carbon\nnamespace: carbon\nversion: 1.0.0\nmcl: ^1.0\nactions:\n  - id: carbon/a\n  - id: carbon/a\n"),
      ).toThrow(expect.objectContaining({ code: "duplicate_name" }));
      // two modules can define the same name
      const set = createModuleSet([
        readModuleManifest(scflow),
        readModuleManifest("name: acme:other\nnamespace: other\nversion: 1.0.0\nmcl: ^1.0\nschemas:\n  - name: actor\n    properties: []\n"),
      ]);
      expect(set.resolveSchema("scflow.actor")?.module.key).toBe("scflow:core");
      expect(set.resolveSchema("other.actor")?.module.key).toBe("acme:other");
    });

    it("embeds mcl:core, with its own manifest", () => {
      expect(MCL_CORE).toMatchObject({ name: "mcl:core", namespace: "mcl", version: "1.0.0" });
      const names = MCL_CORE.schemas.map((s) => s.name);
      for (const name of ["schema", "property", "scalar_type", "dataset", "import", "module", "action"]) expect(names).toContain(name);
      const types = MCL_CORE.scalar_types.map((t) => t.name);
      for (const name of ["date", "identifier", "module_key", "semantic_version", "version_range"]) expect(types).toContain(name);
      // always there, in an empty set too
      const set = createModuleSet([]);
      expect(set.resolveSchema("module")?.module.key).toBe("mcl:core");
      expect(set.resolveSchema("mcl.module")?.key).toBe("module");
    });

    it("refuses two modules with the same namespace", () => {
      expect(() =>
        createModuleSet([
          readModuleManifest(scflow),
          readModuleManifest("name: acme:scflow\nnamespace: scflow\nversion: 1.0.0\nmcl: ^1.0\n"),
        ]),
      ).toThrow(expect.objectContaining({ code: "namespace_conflict" }));
      // `mcl` belongs to mcl:core
      expect(() => createModuleSet([readModuleManifest("name: acme:mcl\nnamespace: mcl\nversion: 1.0.0\nmcl: ^1.0\n")])).toThrow(
        expect.objectContaining({ code: "namespace_conflict" }),
      );
    });

    it("resolves a short name in its own module, then in mcl:core", () => {
      const set = createModuleSet([readModuleManifest(scflow)]);
      const actor = set.module("scflow:core")?.schemas.get("actor");
      // references are kept in their canonical form: qualified, or short for mcl:core
      expect(actor?.properties.find((p) => p.name === "code")?.type).toBe("scflow.code");
      expect(actor?.properties.find((p) => p.name === "founded")?.type).toBe("date");
      expect(set.resolveSchema("actor", "scflow:core")?.key).toBe("scflow.actor");
      expect(set.resolveScalarType("date", "scflow:core")?.module.key).toBe("mcl:core");
    });

    it("lets a module win over mcl:core, which stays reachable by its qualified name", () => {
      const set = createModuleSet([
        readModuleManifest(`
name: acme:calendar
namespace: calendar
version: 1.0.0
mcl: ^1.0
schemas:
  - name: date
    properties:
      - name: day
        type: mcl.date
  - name: meeting
    properties:
      - name: on
        type: date
`),
      ]);
      expect(set.resolveSchema("date", "acme:calendar")?.key).toBe("calendar.date");
      expect(set.resolveScalarType("date", "acme:calendar")).toBeUndefined();
      const meeting = set.module("acme:calendar")?.schemas.get("meeting");
      expect(meeting?.properties.find((p) => p.name === "on")?.type).toBe("calendar.date");
      const date = set.module("acme:calendar")?.schemas.get("date");
      expect(date?.properties.find((p) => p.name === "day")?.type).toBe("date");
    });

    it("resolves only mcl:core short names outside a module", () => {
      const set = createModuleSet([readModuleManifest(scflow), readModuleManifest(carbon)]);
      expect(set.resolveSchema("scflow.actor")?.key).toBe("scflow.actor");
      expect(set.resolveSchema("schema")?.key).toBe("schema");
      // a short name is never searched for across modules
      expect(set.resolveSchema("actor")).toBeUndefined();
      expect(() => set.requireSchema("actor")).toThrow(expect.objectContaining({ code: "unknown_schema" }));
      expect(() => set.requireSchema("nowhere.actor")).toThrow(expect.objectContaining({ code: "unknown_schema" }));
    });

    it("resolves a qualified name in a module to itself, a dependency or mcl:core", () => {
      const set = createModuleSet([readModuleManifest(scflow), readModuleManifest(carbon)]);
      const site = set.module("acme:carbon")?.schemas.get("site");
      expect(site?.extends).toBe("scflow.actor");
      // inherited properties keep the references of the module that declares them
      expect(site?.properties.map((p) => [p.name, p.type])).toEqual([
        ["name", "identifier"],
        ["code", "scflow.code"],
        ["founded", "date"],
        ["co2", "number"],
      ]);
      expect(set.resolveSchema("scflow.actor", "acme:carbon")?.module.key).toBe("scflow:core");
      expect(set.resolveSchema("carbon.site", "acme:carbon")?.module.key).toBe("acme:carbon");
    });

    it("refuses a reference to a module that is not a dependency", () => {
      const intruder = readModuleManifest(`
name: acme:intruder
namespace: intruder
version: 1.0.0
mcl: ^1.0
schemas:
  - name: plant
    properties:
      - name: operator
        type: scflow.actor
`);
      expect(() => createModuleSet([readModuleManifest(scflow), intruder])).toThrow(
        expect.objectContaining({ code: "reference_outside_module" }),
      );
      const set = createModuleSet([readModuleManifest(scflow), readModuleManifest(carbon)]);
      expect(() => set.resolveSchema("scflow.actor", "scflow:core")).not.toThrow();
      expect(() => set.resolveSchema("carbon.site", "scflow:core")).toThrow(expect.objectContaining({ code: "reference_outside_module" }));
    });

    it("refuses a short name of another module, even a dependency", () => {
      const careless = readModuleManifest(`
name: acme:careless
namespace: careless
version: 1.0.0
mcl: ^1.0
dependencies:
  - module: scflow:core
    version: ^1.3
schemas:
  - name: plant
    properties:
      - name: operator
        type: actor
`);
      expect(() => createModuleSet([readModuleManifest(scflow), careless])).toThrow(expect.objectContaining({ code: "unknown_scalar_type" }));
    });
  });

  datasetModuleCases(formatPrefix, newLocator);
  facetCases(formatPrefix, newLocator);
  moduleUpgradeCases(impl, formatPrefix, newLocator);
}

export { runActionConformanceSuite } from "./actions.js";
export { runModuleActionConformanceSuite } from "./moduleActions.js";
export type { ConformanceActionContext, ConformanceDataset, ConformanceEnvironment, ModuleActionImplementation } from "./moduleActions.js";
export type {
  ActionImplementation,
  ConformanceAction,
  ConformanceRefMatches,
  ConformanceRegistry,
  ConformanceRunHost,
  ConformanceRunTrace,
} from "./actions.js";
