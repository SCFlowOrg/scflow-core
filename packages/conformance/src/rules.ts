import { describe, expect, it } from "vitest";
import {
  createApiSession,
  createUpgradeLocator,
  initDataset,
  queryDataset,
  readModuleManifest,
  runCommand,
  runScript,
  upgradeDataset,
  upgradeModule,
} from "@scfloworg/core";
import type { ModuleManifest } from "@scfloworg/core";

type Row = Record<string, unknown>;

/**
 * A small network model of one module, `acme:net`, written to exercise each
 * rule of `packages/core/docs/spec/meta-model.md`, section Rules: a `checks`
 * entry with `require` and one with `exists`, a `unique` group, `acyclic`,
 * `set_once`, `on_delete: confirm`, and defaults that cross relations.
 */
const netModule = (version = "1.0.0", extraSchemas = "", actorExtra = "") => `
name: acme:net
namespace: net
version: ${version}
mcl: ^1.0
title: Net
schemas:
  - name: region
    shared_by_name:
    is_root:
    properties:
      - name: name
        type: identifier
  - name: actor_type
    shared_by_name:
    is_root:
    properties:
      - name: name
        type: identifier
      - name: domains
        type: "[string]"
      - name: default_scope
        type: string
      - name: default_region
        type: region
  - name: item
    shared_by_name:
    is_root:
    properties:
      - name: name
        type: identifier
      - name: domain
        type: string
  - name: actor
    shared_by_name:
    is_root:
    checks:
      - name: parent_actor_domains
        when: { parent: { exists: true } }
        require: { type.domains: { subset_of: "\${this.parent.type.domains}" } }
${actorExtra}
    properties:
      - name: name
        type: identifier
      - name: type
        type: actor_type
        mandatory:
      - name: parent
        type: actor
        acyclic:
      - name: scope
        type: string
        default_value: "\${this.type.default_scope}"
      - name: region
        type: region
        default_value: "\${this.type.default_region}"
      - name: label
        type: string
        default_value: "\${this.name} (\${this.type.default_scope})"
      - name: tags
        type: "[string]"
        default_value: [new]
      - name: code
        type: string
        set_once:
  - name: holding
    is_root:
    unique:
      - name: held_once
        properties: [actor, item]
    properties:
      - name: actor
        type: actor
        mandatory:
        on_delete: confirm
      - name: item
        type: item
        mandatory:
  - name: note
    properties:
      - name: actor
        type: actor
        owner:
        inverse_name: notes
        inverse_is_array:
      - name: text
        type: string
  - name: content
    properties:
      - name: actor
        type: actor
        owner:
        on_delete: confirm
        inverse_name: contents
        inverse_is_array:
      - name: text
        type: string
  - name: flow
    is_root:
    checks:
      - name: carried_item_domain
        when: { item: { exists: true } }
        require:
          and:
            - item.domain: { in: "\${this.source.type.domains}" }
            - item.domain: { in: "\${this.destination.type.domains}" }
      - name: flow_ends_hold_item
        when: { item: { exists: true } }
        each: ["\${this.source}", "\${this.destination}"]
        exists: { schema: holding, with: { actor: "\${each}", item: "\${this.item}" } }
    properties:
      - name: source
        type: actor
        mandatory:
      - name: destination
        type: actor
        mandatory:
      - name: item
        type: item
${extraSchemas}
`;

/**
 * Rules: piece 5.3 of phase C, per `packages/core/docs/spec/meta-model.md`
 * (Rules, On Delete, Property Constraints, Placeholders, Model Upgrade) and
 * `model-command-language.md` (Filter, Command, Schema Processing).
 */
export function ruleCases(formatPrefix: string, newLocator: () => string): void {
  const net = readModuleManifest(netModule());

  async function datasetWith(modules: ModuleManifest[] = [net]): Promise<string> {
    const locator = newLocator();
    await initDataset(locator, "rules", { modules });
    return locator;
  }

  const create = (locator: string, schema: string, input: unknown) => runCommand(locator, { create: schema, input });
  const query = async (locator: string, schema: string, filters?: Row) =>
    (await runCommand(locator, { query: schema, ...(filters ? { filters } : {}) })).after as Row[];
  const codeOf = (promise: Promise<unknown>) => promise.then(() => "ok", (e: { code?: string }) => e.code);

  /** A network: two actor types sharing the domain `food`, two actors, an item of domain `food` held by both. */
  async function network(): Promise<string> {
    const locator = await datasetWith();
    await create(locator, "net.region", [{ name: "north" }]);
    await create(locator, "net.actor_type", [
      { name: "farm", domains: ["food", "wood"], default_scope: "local", default_region: "north" },
      { name: "shop", domains: ["food"] },
    ]);
    await create(locator, "net.item", [{ name: "apple", domain: "food" }, { name: "plank", domain: "wood" }]);
    await create(locator, "net.actor", [{ name: "f1", type: "farm" }, { name: "s1", type: "shop" }]);
    await create(locator, "net.holding", [{ actor: "f1", item: "apple" }, { actor: "s1", item: "apple" }]);
    return locator;
  }

  describe(`filter conformance (paths on the right, subset_of) — ${formatPrefix}`, () => {
    it("subset_of holds when every entry is in the given array, whatever the order, and for an empty value", async () => {
      const locator = await network();
      await create(locator, "net.actor_type", [{ name: "none", domains: [] }]);
      const names = async (filters: Row) => (await query(locator, "net.actor_type", filters)).map((r) => r.name).sort();
      expect(await names({ domains: { subset_of: ["wood", "food", "stone"] } })).toEqual(["farm", "none", "shop"]);
      expect(await names({ domains: { subset_of: ["food"] } })).toEqual(["none", "shop"]);
      expect(await codeOf(query(locator, "net.item", { domain: { subset_of: ["food"] } }))).toBe("invalid_operator");
      expect(await codeOf(query(locator, "net.actor_type", { domains: { subset_of: "food" } }))).toBe("type_mismatch");
    });

    it("resolves a path on the right per instance, and a missing value satisfies nothing", async () => {
      const locator = await network();
      await create(locator, "net.actor", [{ name: "f2", type: "farm", parent: "f1" }, { name: "s2", type: "shop", parent: "f1" }]);
      const subset = await query(locator, "net.actor", { "type.domains": { subset_of: "${this.parent.type.domains}" } });
      expect(subset.map((r) => r.name).sort()).toEqual(["f2", "s2"]);
      // f1 and s1 have no parent: the right side is missing, ne included
      const unequal = await query(locator, "net.actor", { type: { ne: "${this.parent.type}" } });
      expect(unequal.map((r) => r.name).sort()).toEqual(["s2"]);
    });

    it("refuses a placeholder on the right that is not one whole plain path starting at this", async () => {
      const locator = await network();
      for (const operand of ["${this.parent} x", "${now()}", "${params.x}", "${this.parent}${this.type}"]) {
        expect(await codeOf(query(locator, "net.actor", { name: { eq: operand } }))).toBe("invalid_filter");
      }
      expect(await codeOf(query(locator, "net.actor", { name: { eq: "${this.nothing}" } }))).toBe("unknown_property");
    });
  });

  describe(`default_value conformance (paths across relations) — ${formatPrefix}`, () => {
    it("reads a default across a relation, keeps the type of a whole placeholder and copies a literal array", async () => {
      const locator = await network();
      const [f1] = await query(locator, "net.actor", { name: "f1" });
      expect(f1).toMatchObject({ scope: "local", region: "north", label: "f1 (local)", tags: ["new"] });
      // a null relation on the path gives the ordinary default
      const [s1] = await query(locator, "net.actor", { name: "s1" });
      expect(s1).toMatchObject({ scope: "", region: null, tags: ["new"] });
    });

    it("prefers a given value, and an explicit null means none", async () => {
      const locator = await network();
      const created = await create(locator, "net.actor", [{ name: "f3", type: "farm", scope: "global", region: null, tags: [] }]);
      expect(created.after[0]).toMatchObject({ scope: "global", region: null, label: "f3 (local)", tags: [] });
    });

    it("applies a default once, at creation", async () => {
      const locator = await network();
      await runCommand(locator, { update: "net.actor_type", filters: { name: "farm" }, input: { default_scope: "wide" } });
      const [f1] = await query(locator, "net.actor", { name: "f1" });
      expect(f1.scope).toBe("local");
    });
  });

  describe(`set_once conformance — ${formatPrefix}`, () => {
    it("sets a value once, accepts the same value again and refuses any other change", async () => {
      const locator = await network();
      await runCommand(locator, { update: "net.actor", filters: { name: "f1" }, input: { code: "F-1" } });
      await runCommand(locator, { update: "net.actor", filters: { name: "f1" }, input: { code: "F-1" } });
      expect(await codeOf(runCommand(locator, { update: "net.actor", filters: { name: "f1" }, input: { code: "F-2" } }))).toBe("constraint_violation");
      expect(await codeOf(runCommand(locator, { update: "net.actor", filters: { name: "f1" }, input: { code: "" } }))).toBe("constraint_violation");
      const created = await create(locator, "net.actor", [{ name: "f4", type: "farm", code: "F-4" }]);
      expect(created.after[0]).toMatchObject({ code: "F-4" });
      expect(await codeOf(runCommand(locator, { update: "net.actor", filters: { name: "f4" }, input: { code: "F-5" } }))).toBe("constraint_violation");
    });
  });

  describe(`on_delete confirm conformance — ${formatPrefix}`, () => {
    it("refuses a plain delete and removes the instance with cascade: true", async () => {
      const locator = await network();
      await create(locator, "net.actor", [{ name: "lone", type: "shop" }]);
      await create(locator, "net.item", [{ name: "pear", domain: "food" }]);
      await create(locator, "net.holding", [{ actor: "lone", item: "pear" }]);
      expect(await codeOf(runCommand(locator, { delete: "net.actor", filters: { name: "lone" } }))).toBe("constraint_violation");
      expect(await query(locator, "net.actor", { name: "lone" })).toHaveLength(1);
      const deleted = await runCommand(locator, { delete: "net.actor", filters: { name: "lone" }, cascade: true });
      expect(deleted["cascade-deleted"]).toMatchObject([{ actor: "lone", item: "pear" }]);
      expect(await query(locator, "net.holding", { actor: "lone" })).toHaveLength(0);
    });

    it("asks for consent on an owner relation, while the other owned parts go silently", async () => {
      const locator = await network();
      await create(locator, "net.actor", [{ name: "solo", type: "shop" }]);
      await create(locator, "net.note", [{ actor: "solo", text: "a note" }]);
      // a part goes with its owner silently
      await runCommand(locator, { delete: "net.actor", filters: { name: "solo" } });
      expect(await query(locator, "net.note")).toHaveLength(0);

      await create(locator, "net.actor", [{ name: "solo", type: "shop" }]);
      await create(locator, "net.content", [{ actor: "solo", text: "content" }]);
      expect(await codeOf(runCommand(locator, { delete: "net.actor", filters: { name: "solo" } }))).toBe("constraint_violation");
      const deleted = await runCommand(locator, { delete: "net.actor", filters: { name: "solo" }, cascade: true });
      expect(deleted["cascade-deleted"]).toMatchObject([{ text: "content" }]);
    });

    it("refuses cascade on any command but delete", async () => {
      const locator = await network();
      expect(await codeOf(runCommand(locator, { query: "net.actor", cascade: true }))).toBe("constraint_violation");
      expect(await codeOf(runCommand(locator, { delete: "net.actor", filters: { name: "zzz" }, cascade: "yes" }))).toBe("constraint_violation");
    });
  });

  describe(`declared rules conformance — ${formatPrefix}`, () => {
    it("refuses a command that breaks a require rule, naming the rule, the schema and the instance, and writes nothing", async () => {
      const locator = await network();
      const versionBefore = ((await queryDataset(locator)) as Row).data_minor_version;
      const error = await create(locator, "net.flow", [{ source: "f1", destination: "s1", item: "plank" }]).catch((e) => e);
      expect(error).toMatchObject({ code: "rule_violation", details: { rule: "carried_item_domain", schema: "net.flow" } });
      expect(typeof error.details.key).toBe("string");
      expect(await query(locator, "net.flow")).toHaveLength(0);
      expect(((await queryDataset(locator)) as Row).data_minor_version).toBe(versionBefore);
      await create(locator, "net.flow", [{ source: "f1", destination: "s1", item: "apple" }]);
      // a flow with no item is outside `when`
      await create(locator, "net.flow", [{ source: "f1", destination: "s1" }]);
      expect(await query(locator, "net.flow")).toHaveLength(2);
    });

    it("re-evaluates a rule when a path it reads changes", async () => {
      const locator = await network();
      await create(locator, "net.flow", [{ source: "f1", destination: "s1", item: "apple" }]);
      const error = await runCommand(locator, { update: "net.item", filters: { name: "apple" }, input: { domain: "wood" } }).catch((e) => e);
      expect(error).toMatchObject({ code: "rule_violation", details: { rule: "carried_item_domain", schema: "net.flow" } });
      expect((await query(locator, "net.item", { name: "apple" }))[0].domain).toBe("food");
      expect(await codeOf(runCommand(locator, { update: "net.actor_type", filters: { name: "shop" }, input: { domains: ["wood"] } }))).toBe("rule_violation");
    });

    it("checks an exists rule from both sides: the requiring instance and the instances it needs", async () => {
      const locator = await network();
      await create(locator, "net.item", [{ name: "pear", domain: "food" }]);
      await create(locator, "net.holding", [{ actor: "f1", item: "pear" }]);
      const error = await create(locator, "net.flow", [{ source: "f1", destination: "s1", item: "pear" }]).catch((e) => e);
      expect(error).toMatchObject({ code: "rule_violation", details: { rule: "flow_ends_hold_item", schema: "net.flow" } });
      await create(locator, "net.flow", [{ source: "f1", destination: "s1", item: "apple" }]);
      expect(await codeOf(runCommand(locator, { delete: "net.holding", filters: { actor: "s1", item: "apple" } }))).toBe("rule_violation");
      expect(await codeOf(runCommand(locator, { update: "net.holding", filters: { actor: "s1", item: "apple" }, input: { item: "pear" } }))).toBe("rule_violation");
      expect(await query(locator, "net.holding", { actor: "s1" })).toMatchObject([{ item: "apple" }]);
    });

    it("refuses two instances that share the values of a unique group, and a null relation does not count", async () => {
      const locator = await network();
      const error = await create(locator, "net.holding", [{ actor: "f1", item: "apple" }]).catch((e) => e);
      expect(error).toMatchObject({ code: "rule_violation", details: { rule: "held_once", schema: "net.holding" } });
      const twice = await create(locator, "net.holding", [{ actor: "f1", item: "plank" }, { actor: "f1", item: "plank" }]).catch((e) => e);
      expect(twice.code).toBe("rule_violation");
      await create(locator, "net.holding", [{ actor: "f1", item: "plank" }]);
      expect(await codeOf(runCommand(locator, { update: "net.holding", filters: { item: "plank" }, input: { item: "apple" } }))).toBe("rule_violation");
    });

    it("refuses a cycle of an acyclic relation", async () => {
      const locator = await network();
      await create(locator, "net.actor", [{ name: "a", type: "farm" }, { name: "b", type: "farm", parent: "a" }, { name: "c", type: "farm", parent: "b" }]);
      const error = await runCommand(locator, { update: "net.actor", filters: { name: "a" }, input: { parent: "c" } }).catch((e) => e);
      expect(error).toMatchObject({ code: "rule_violation", details: { rule: "parent", schema: "net.actor" } });
      expect(await codeOf(runCommand(locator, { update: "net.actor", filters: { name: "a" }, input: { parent: "a" } }))).toBe("rule_violation");
      expect((await query(locator, "net.actor", { name: "a" }))[0].parent).toBeNull();
    });

    it("checks the rules at the end of a transaction, so an instance can be invalid on the way", async () => {
      const locator = await network();
      const session = createApiSession();
      await create(locator, "net.item", [{ name: "pear", domain: "food" }]);
      const tx = await session.beginTransaction(locator, "flow with its holdings");
      await session.runCommand(locator, { create: "net.flow", input: [{ source: "f1", destination: "s1", item: "pear" }] });
      await session.runCommand(locator, { create: "net.holding", input: [{ actor: "f1", item: "pear" }, { actor: "s1", item: "pear" }] });
      await session.prepareTransaction(locator, tx);
      await session.commitTransaction(locator, tx);
      expect(await query(locator, "net.flow", { item: "pear" })).toHaveLength(1);

      const broken = await session.beginTransaction(locator, "broken");
      await session.runCommand(locator, { create: "net.flow", input: [{ source: "f1", destination: "s1", item: "plank" }] });
      expect(await codeOf(session.prepareTransaction(locator, broken))).toBe("rule_violation");
      await session.rollbackTransaction(locator, broken);
      expect(await query(locator, "net.flow", { item: "plank" })).toHaveLength(0);
    });

    it("lets a rule keep holding across a script, checked once at its end", async () => {
      const locator = await network();
      await create(locator, "net.item", [{ name: "pear", domain: "food" }]);
      await runCommand(locator, { create: "net.holding", input: [{ actor: "f1", item: "pear" }] });
      const script = {
        commands: [
          { create: "net.flow", input: [{ source: "f1", destination: "s1", item: "pear" }] },
          { create: "net.holding", input: [{ actor: "s1", item: "pear" }] },
        ],
      };
      await runScript(locator, script);
      expect(await query(locator, "net.flow", { item: "pear" })).toHaveLength(1);
    });

    it("keeps the rules of a parent schema on a schema that extends it", async () => {
      const extra = `
  - name: special_actor
    extends: actor
    checks:
      - name: special_has_code
        require: { code: { ne: "" } }
    properties:
      - name: grade
        type: integer
`;
      const locator = await datasetWith([readModuleManifest(netModule("1.0.0", extra))]);
      await create(locator, "net.actor_type", [{ name: "farm", domains: ["food"] }, { name: "wide", domains: ["food", "wood"] }]);
      await create(locator, "net.actor", [{ name: "p", type: "farm" }]);
      expect(await codeOf(create(locator, "net.special_actor", [{ name: "x", type: "farm" }]))).toBe("rule_violation");
      const error = await create(locator, "net.special_actor", [{ name: "y", type: "wide", parent: "p", code: "Y" }]).catch((e) => e);
      expect(error).toMatchObject({ code: "rule_violation", details: { rule: "parent_actor_domains" } });
      await create(locator, "net.special_actor", [{ name: "z", type: "farm", parent: "p", code: "Z" }]);
    });
  });

  describe(`rule declarations in schema processing — ${formatPrefix}`, () => {
    const refused = async (extraSchemas: string, actorExtra = "") =>
      codeOf(initDataset(newLocator(), "refused", { modules: [readModuleManifest(netModule("1.0.0", extraSchemas, actorExtra))] }));
    const thing = (body: string) => `
  - name: thing
    is_root:
${body}
    properties:
      - name: actor
        type: actor
      - name: size
        type: integer
      - name: labels
        type: "[string]"
      - name: names
        type: "{language_code: string}"
`;

    it("refuses a malformed checks entry", async () => {
      expect(await refused(thing(`    checks:\n      - name: twice\n        require: { size: 1 }\n      - name: twice\n        require: { size: 2 }`))).toBe("constraint_violation");
      expect(await refused(thing(`    checks:\n      - name: both\n        require: { size: 1 }\n        exists: { schema: item, with: { name: x } }`))).toBe("constraint_violation");
      expect(await refused(thing(`    checks:\n      - name: neither\n        when: { size: 1 }`))).toBe("constraint_violation");
      expect(await refused(thing(`    checks:\n      - name: lone_each\n        each: ["\${this.actor}"]\n        require: { size: 1 }`))).toBe("constraint_violation");
      expect(await refused(thing(`    checks:\n      - name: array_path\n        require: { actor.notes.text: x }`))).toBe("constraint_violation");
      expect(await refused(thing(`    checks:\n      - name: no_schema\n        exists: { schema: nothing, with: { name: x } }`))).toBe("unknown_schema");
    });

    it("refuses a unique group that names something other than a direct scalar or single-valued relation", async () => {
      expect(await refused(thing(`    unique:\n      - name: path\n        properties: [actor.name]`))).toBe("constraint_violation");
      expect(await refused(thing(`    unique:\n      - name: array\n        properties: [labels]`))).toBe("constraint_violation");
      expect(await refused(thing(`    unique:\n      - name: map\n        properties: [names]`))).toBe("constraint_violation");
      expect(await refused(thing(`    unique:\n      - name: twice\n        properties: [size]\n      - name: twice\n        properties: [actor]`))).toBe("constraint_violation");
    });

    it("refuses acyclic on a relation to another schema, and set_once with constant, on an array or on a map", async () => {
      expect(await refused(`
  - name: tree
    is_root:
    properties:
      - name: up
        type: item
        acyclic:
`)).toBe("constraint_violation");
      expect(await refused(`
  - name: once
    is_root:
    properties:
      - name: a
        type: string
        set_once:
        constant:
`)).toBe("constraint_violation");
      expect(await refused(`
  - name: once
    is_root:
    properties:
      - name: a
        type: "[string]"
        set_once:
`)).toBe("constraint_violation");
      expect(await refused(`
  - name: once
    is_root:
    properties:
      - name: a
        type: "{language_code: string}"
        set_once:
`)).toBe("constraint_violation");
    });

    it("accepts on_delete confirm, which is the only value an owner relation takes", async () => {
      expect(await refused(`
  - name: part
    properties:
      - name: actor
        type: actor
        owner:
        on_delete: cascade
`)).toBe("constraint_violation");
      expect(await refused(`
  - name: link
    is_root:
    properties:
      - name: actor
        type: actor
        on_delete: maybe
`)).toBe("constraint_violation");
    });
  });

  describe(`rules and upgrades — ${formatPrefix}`, () => {
    it("refuses a module upgrade that breaks a rule, with the list of the instances at fault, and changes nothing", async () => {
      const locator = await network();
      await create(locator, "net.actor", [{ name: "f2", type: "farm" }]);
      const stricter = readModuleManifest(
        netModule("1.1.0", "", `      - name: actor_has_code\n        require: { code: { ne: "" } }`),
      );
      const error = await upgradeModule(locator, stricter).catch((e) => e);
      expect(error.code).toBe("rule_violation");
      const atFault = (error.details.violations as Row[]).map((v) => v.key).sort();
      expect(atFault).toEqual(["f1", "f2", "s1"]);
      const info = (await queryDataset(locator)) as Row;
      expect((info.modules as Row[]).find((m) => m.module === "acme:net")).toMatchObject({ version: "1.0.0" });

      for (const name of ["f1", "f2", "s1"]) {
        await runCommand(locator, { update: "net.actor", filters: { name }, input: { code: name.toUpperCase() } });
      }
      await upgradeModule(locator, stricter);
      const after = (await queryDataset(locator)) as Row;
      expect((after.modules as Row[]).find((m) => m.module === "acme:net")).toMatchObject({ version: "1.1.0" });
    });

    it("refuses an upgrade of the schemas of a dataset that breaks a rule", async () => {
      const locator = newLocator();
      await initDataset(locator, "local-rules");
      const upgrade = await createUpgradeLocator(locator);
      await runCommand(upgrade, { create: "schema", input: [{ name: "box", is_root: null, properties: [{ name: "size", type: "integer" }] }] });
      await upgradeDataset(locator, upgrade);
      await runCommand(locator, { create: "box", input: [{ size: 0 }, { size: 3 }] });
      const stricter = await createUpgradeLocator(locator);
      await runCommand(stricter, {
        update: "schema",
        filters: { name: "box" },
        input: [{ is_root: null, checks: [{ name: "positive", require: { size: { gt: 0 } } }], properties: [{ name: "size", type: "integer" }] }],
      });
      const error = await upgradeDataset(locator, stricter).catch((e) => e);
      expect(error.code).toBe("rule_violation");
      expect(error.details.violations).toHaveLength(1);
      expect(await codeOf(runCommand(locator, { create: "box", input: [{ size: 0 }] }))).toBe("ok");
    });
  });
}
