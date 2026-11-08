import { describe, expect, it } from "vitest";
import { readModuleManifest } from "@scfloworg/core";
import type { AuthoredCommand, ModuleManifest } from "@scfloworg/core";

/**
 * The cases of the actions of a module, which need a dataset: the write limit,
 * the generated actions with those of a facet, the impact of a delete and the
 * seeding of singletons. They follow the Action section of
 * `packages/core/docs/spec/meta-model.md` and the *Actions* part of Schema
 * Processing in `model-command-language.md`.
 *
 * An environment proves it follows them by calling
 * `runModuleActionConformanceSuite(impl)` from its own test file, as
 * `packages/environment/tests/conformance.test.ts` does. The types below are the
 * shape the suite uses, so this package does not depend on the one it checks.
 */

type Row = Record<string, unknown>;

/** The context of a body, as the suite uses it. */
export interface ConformanceActionContext {
  readonly locator: string;
  runCommand(locator: string, command: AuthoredCommand): Promise<{ after: unknown[] }>;
}

/** A body of an action, as the environment calls it. */
export type ConformanceBody = (context: ConformanceActionContext, params: never) => unknown;

/** A dataset opened by an environment, as the suite uses it. */
export interface ConformanceDataset {
  run(id: string, params?: unknown): Promise<{ result: unknown }>;
  query(command: AuthoredCommand): Promise<{ after: unknown[] }>;
  actions(): readonly { id: string; kind?: string; destructive?: boolean; parameters?: unknown }[];
  deleteImpact(schema: string, filters?: unknown): Promise<unknown>;
}

/** An environment, as the suite uses it. */
export interface ConformanceEnvironment {
  readonly modules: { install(module: unknown): unknown };
  readonly datasets: { create(options: { modules: string[] }): Promise<ConformanceDataset> };
}

/** What an implementation of the environment gives the suite. */
export interface ModuleActionImplementation {
  /** A new environment, sharing nothing with another one. */
  createEnvironment(): ConformanceEnvironment;
  /** The module of `manifest` with the bodies of `actions`, by short name. */
  defineModule(manifest: ModuleManifest, code: { actions: Record<string, unknown> }): unknown;
}

const SHOP = `
name: acme:shop
namespace: shop
version: 1.0.0
mcl: ^1.0
title: Shop
schemas:
  - name: settings
    is_root:
    singleton:
    properties:
      - name: currency
        type: string
        default_value: EUR
  - name: base
    abstract:
    is_root:
    properties:
      - name: label
        type: string
  - name: site
    is_root:
    properties:
      - name: display_name
        type: string
        mandatory:
      - name: code
        type: string
        constant:
      - name: note
        type: string
        updated_by: shop/set_note
      - name: status
        type: string
        enum: [open, closed]
        default_value: open
  - name: order
    is_root:
    properties:
      - name: site
        type: site
        mandatory:
  - name: stock
    is_root:
    properties:
      - name: site
        type: site
        on_delete: cascade
  - name: booking
    is_root:
    properties:
      - name: site
        type: site
        on_delete: confirm
  - name: kiosk
    is_root:
    crud:
      create: shop/open_kiosk
      delete: none
    properties:
      - name: label
        type: string
actions:
  - id: shop/set_note
    writes: [site]
  - id: shop/open_kiosk
    writes: [kiosk]
  - id: shop/write_other_schema
    writes: [site]
  - id: shop/write_undeclared
  - id: shop/write_in_read
    kind: read
    writes: [site]
  - id: shop/write_foreign_facet
    writes: [site]
  - id: shop/open_and_close
    parameters:
      type: object
      properties:
        name:
          type: string
      required: [name]
    body:
      commands:
        - call: shop/create_site
          with:
            display_name: \${params.name}
          as: site
        - call: shop/update_site
          with:
            id: \${site.id}
            status: closed
      result: \${site.id}
  - id: shop/create_then_fail
    writes: [site]
    body:
      commands:
        - create: shop.site
          input:
            - display_name: doomed
        - fail: refused
  - id: shop/procedure_undeclared
    body:
      commands:
        - create: shop.kiosk
          input:
            - label: k
  - id: shop/procedure_bad_call
    body:
      commands:
        - call: shop/create_site
          with:
            nope: 1
  - id: shop/procedure_out_of_reach
    body:
      commands:
        - call: green/get_footprint
          with:
            id: x
`;

const GREEN = `
name: acme:green
namespace: green
version: 1.0.0
mcl: ^1.0
title: Green
dependencies:
  - module: acme:shop
    version: ^1.0
schemas:
  - name: footprint
    facet_of: shop.site
    properties:
      - name: co2
        type: number
actions:
  - id: green/set_co2
    writes: [footprint]
  - id: green/write_target
    writes: [footprint]
`;

const update = (context: ConformanceActionContext, command: Row) =>
  context.runCommand(context.locator, command as AuthoredCommand);

const shopCode = {
  actions: {
    set_note: (context: ConformanceActionContext, params: { id: string; note: string }) =>
      update(context, {
        update: "shop.site",
        filters: { id: params.id },
        input: { note: params.note },
      }),
    open_kiosk: async (context: ConformanceActionContext) =>
      update(context, { create: "shop.kiosk", input: [{ label: "k" }] }),
    write_other_schema: (context: ConformanceActionContext) =>
      update(context, { create: "shop.kiosk", input: [{ label: "k" }] }),
    write_undeclared: (context: ConformanceActionContext) =>
      update(context, { create: "shop.kiosk", input: [{ label: "k" }] }),
    write_in_read: (context: ConformanceActionContext) =>
      update(context, { create: "shop.site", input: [{ display_name: "x" }] }),
    write_foreign_facet: (context: ConformanceActionContext, params: { id: string }) =>
      update(context, { update: "shop.site", filters: { id: params.id }, input: { green: { co2: 1 } } }),
  },
};

const greenCode = {
  actions: {
    set_co2: (context: ConformanceActionContext, params: { id: string; co2: number }) =>
      update(context, {
        update: "shop.site",
        filters: { id: params.id },
        input: { green: { co2: params.co2 } },
      }),
    write_target: (context: ConformanceActionContext, params: { id: string }) =>
      update(context, { update: "shop.site", filters: { id: params.id }, input: { display_name: "x" } }),
  },
};

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return (error as { code?: string }).code;
  }
  throw new Error("expected a refusal");
}

export function runModuleActionConformanceSuite(impl: ModuleActionImplementation): void {
  async function dataset(): Promise<ConformanceDataset> {
    const env = impl.createEnvironment();
    env.modules.install(impl.defineModule(readModuleManifest(SHOP), shopCode));
    env.modules.install(impl.defineModule(readModuleManifest(GREEN), greenCode));
    return env.datasets.create({ modules: ["acme:green"] });
  }

  /** Creating a dataset of a module `yaml` with bodies for its declared actions. */
  function creating(yaml: string, actions: Record<string, unknown> = {}) {
    const env = impl.createEnvironment();
    env.modules.install(impl.defineModule(readModuleManifest(yaml), { actions }));
    return env.datasets.create({ modules: ["acme:bad"] });
  }

  const created = async (ds: ConformanceDataset, name = "Paris"): Promise<string> =>
    ((await ds.run("shop/create_site", { display_name: name })).result as Row).id as string;

  const header = (extra: string) => `
name: acme:bad
namespace: bad
version: 1.0.0
mcl: ^1.0
title: Bad
${extra}
`;

  describe("the actions of a module", () => {
    describe("declarations", () => {
      const noop = { ok: () => 1 };
      const cases: [string, string][] = [
        [
          "a crud id that is no action of the module",
          `schemas:\n  - name: a\n    is_root:\n    crud:\n      create: bad/nope\n    properties: []`,
        ],
        [
          "an updated_by that is no action of the module",
          `schemas:\n  - name: a\n    is_root:\n    properties:\n      - name: p\n        type: string\n        updated_by: bad/nope`,
        ],
        [
          "an updated_by on a constant property",
          `schemas:\n  - name: a\n    is_root:\n    properties:\n      - name: p\n        type: string\n        constant:\n        updated_by: bad/ok\nactions:\n  - id: bad/ok`,
        ],
        [
          "a crud create on a singleton",
          `schemas:\n  - name: a\n    is_root:\n    singleton:\n    crud:\n      create: bad/ok\n    properties: []\nactions:\n  - id: bad/ok`,
        ],
        [
          "a writes that names mcl:core",
          `actions:\n  - id: bad/ok\n    writes: [schema]`,
        ],
        [
          "a writes that names no schema",
          `actions:\n  - id: bad/ok\n    writes: [nope]`,
        ],
      ];
      for (const [name, body] of cases) {
        it(`refuses ${name}`, async () => {
          const actions = body.includes("bad/ok") ? noop : {};
          expect(await codeOf(creating(header(body), actions))).toBe("constraint_violation");
        });
      }
    });

    describe("write limit", () => {
      it("lets an action write the schemas it declares and its own facet", async () => {
        const ds = await dataset();
        const id = await created(ds);
        await ds.run("shop/set_note", { id, note: "n" });
        await ds.run("green/set_co2", { id, co2: 3 });
        const site = (await ds.query({ query: "shop.site", filters: { id } })).after[0] as Row;
        expect(site).toMatchObject({ note: "n", green: { co2: 3 } });
      });

      for (const [action, what] of [
        ["shop/write_other_schema", "a schema outside its writes"],
        ["shop/write_undeclared", "anything without writes"],
        ["shop/write_in_read", "anything in a read action"],
      ]) {
        it(`refuses ${what}`, async () => {
          const ds = await dataset();
          expect(await codeOf(ds.run(action))).toBe("write_not_declared");
          expect((await ds.query({ query: "shop.kiosk" })).after).toEqual([]);
        });
      }

      it("refuses the facet of another module, and the target of its own facet", async () => {
        const ds = await dataset();
        const id = await created(ds);
        expect(await codeOf(ds.run("shop/write_foreign_facet", { id }))).toBe("write_not_declared");
        expect(await codeOf(ds.run("green/write_target", { id }))).toBe("write_not_declared");
      });
    });

    describe("generated actions", () => {
      const ids = async () => (await dataset()).actions().map((a) => a.id);

      it("generates create, update and delete, not for an abstract schema", async () => {
        expect(await ids()).toEqual(
          expect.arrayContaining(["shop/create_site", "shop/update_site", "shop/delete_site"]),
        );
        expect(await ids()).not.toContain("shop/create_base");
      });

      it("offers what crud offers, and no create or delete for a singleton", async () => {
        const all = await ids();
        expect(all).toContain("shop/update_kiosk");
        expect(all).toContain("shop/open_kiosk");
        expect(all).not.toContain("shop/create_kiosk");
        expect(all).not.toContain("shop/delete_kiosk");
        expect(all).toContain("shop/update_settings");
        expect(all).not.toContain("shop/create_settings");
        expect(all).not.toContain("shop/delete_settings");
      });

      it("gives a facet update and get actions only", async () => {
        const all = await ids();
        expect(all).toContain("green/update_footprint");
        expect(all).toContain("green/get_footprint");
        expect(all).not.toContain("green/create_footprint");
        expect(all).not.toContain("green/delete_footprint");
      });

      it("keeps the facet out of the signature of its target", async () => {
        const ds = await dataset();
        const site = ds.actions().find((a) => a.id === "shop/create_site") as {
          parameters: { properties: Row };
        };
        expect(Object.keys(site.parameters.properties).sort()).toEqual(
          ["code", "display_name", "note", "status"].sort(),
        );
        expect(await codeOf(ds.run("shop/create_site", { display_name: "x", green: { co2: 1 } }))).toBe(
          "invalid_parameters",
        );
      });

      it("applies mandatory and default_value to the create", async () => {
        const ds = await dataset();
        expect(await codeOf(ds.run("shop/create_site", {}))).toBe("invalid_parameters");
        const { result } = await ds.run("shop/create_site", { display_name: "x" });
        expect(result).toMatchObject({ display_name: "x", status: "open" });
      });

      it("leaves constant and updated_by properties out of the update", async () => {
        const ds = await dataset();
        const id = await created(ds);
        for (const input of [{ code: "c" }, { note: "n" }]) {
          expect(await codeOf(ds.run("shop/update_site", { id, ...input }))).toBe("invalid_parameters");
        }
        const { result } = await ds.run("shop/update_site", { id, status: "closed" });
        expect(result).toMatchObject({ status: "closed" });
      });

      it("takes a relation and the target by id or display name", async () => {
        const ds = await dataset();
        const id = await created(ds, "Lyon");
        const byName = await ds.run("shop/create_order", { site: "Lyon" });
        expect(byName.result).toMatchObject({ site: id });
        const updated = await ds.run("shop/update_site", { id: "Lyon", status: "closed" });
        expect(updated.result).toMatchObject({ id, status: "closed" });
        expect(await codeOf(ds.run("shop/create_order", { site: "Nowhere" }))).toBe("invalid_parameters");
      });

      it("deletes, and marks the action destructive", async () => {
        const ds = await dataset();
        const id = await created(ds);
        expect(ds.actions().find((a) => a.id === "shop/delete_site")?.destructive).toBe(true);
        await ds.run("shop/delete_site", { id });
        expect((await ds.query({ query: "shop.site" })).after).toEqual([]);
      });

      it("updates and reads a facet by the id of its target", async () => {
        const ds = await dataset();
        const id = await created(ds);
        expect((await ds.run("green/get_footprint", { id })).result).toEqual({});
        await ds.run("green/update_footprint", { id, co2: 7 });
        expect((await ds.run("green/get_footprint", { id })).result).toEqual({ co2: 7 });
        const kind = ds.actions().find((a) => a.id === "green/get_footprint")?.kind;
        expect(kind).toBe("read");
      });
    });

    describe("procedures", () => {
      it("runs a declared procedure, its calls in one transaction", async () => {
        const ds = await dataset();
        const { result } = await ds.run("shop/open_and_close", { name: "Lille" });
        const { after } = await ds.query({ query: "shop.site" });
        expect(after).toMatchObject([{ id: result, display_name: "Lille", status: "closed" }]);
      });

      it("checks the parameters of a procedure", async () => {
        const ds = await dataset();
        expect(await codeOf(ds.run("shop/open_and_close", {}))).toBe("invalid_parameters");
      });

      it("rolls back when a fail step runs", async () => {
        const ds = await dataset();
        expect(await codeOf(ds.run("shop/create_then_fail"))).toBe("procedure_failed");
        expect((await ds.query({ query: "shop.site" })).after).toEqual([]);
      });

      it("holds a procedure to the write limit", async () => {
        const ds = await dataset();
        expect(await codeOf(ds.run("shop/procedure_undeclared"))).toBe("write_not_declared");
      });

      it("sends a call step through the checks of an action", async () => {
        const ds = await dataset();
        expect(await codeOf(ds.run("shop/procedure_bad_call"))).toBe("invalid_parameters");
      });

      it("calls only its own module and its dependencies", async () => {
        const ds = await dataset();
        expect(await codeOf(ds.run("shop/procedure_out_of_reach"))).toBe("unknown_action");
      });
    });

    describe("cascade of a delete", () => {
      it("asks for consent on a confirm relation, and cascade gives it", async () => {
        const ds = await dataset();
        const id = await created(ds);
        await ds.run("shop/create_booking", { site: id });
        expect(await codeOf(ds.run("shop/delete_site", { id }))).toBe("constraint_violation");
        expect((await ds.query({ query: "shop.booking" })).after).toHaveLength(1);
        await ds.run("shop/delete_site", { id, cascade: true });
        expect((await ds.query({ query: "shop.site" })).after).toEqual([]);
        expect((await ds.query({ query: "shop.booking" })).after).toEqual([]);
      });

      it("counts a confirm relation in the impact, unblocked", async () => {
        const ds = await dataset();
        const id = await created(ds);
        const booking = ((await ds.run("shop/create_booking", { site: id })).result as Row).id;
        const impact = (await ds.deleteImpact("shop.site", { id })) as { removed: Row[]; blocked: Row[] };
        expect(impact.blocked).toEqual([]);
        expect(impact.removed).toEqual(expect.arrayContaining([{ schema: "shop.booking", key: booking }]));
      });
    });

    describe("impact of a delete", () => {
      it("gives what would go, facets included, and writes nothing", async () => {
        const ds = await dataset();
        const id = await created(ds);
        await ds.run("green/update_footprint", { id, co2: 7 });
        const stock = ((await ds.run("shop/create_stock", { site: id })).result as Row).id;
        const impact = (await ds.deleteImpact("shop.site", { id })) as { removed: Row[]; blocked: Row[] };
        expect(impact.blocked).toEqual([]);
        expect(impact.removed).toEqual(
          expect.arrayContaining([
            { schema: "shop.site", key: id },
            { schema: "green.footprint", key: id },
            { schema: "shop.stock", key: stock },
          ]),
        );
        expect(impact.removed).toHaveLength(3);
        expect((await ds.query({ query: "shop.site" })).after).toHaveLength(1);
      });

      it("names what restricts the delete", async () => {
        const ds = await dataset();
        const id = await created(ds);
        const order = ((await ds.run("shop/create_order", { site: id })).result as Row).id;
        const impact = (await ds.deleteImpact("shop.site", { id })) as { blocked: Row[] };
        expect(impact.blocked).toEqual([
          { schema: "shop.order", key: order, property: "site", target: { schema: "shop.site", key: id } },
        ]);
      });
    });

    describe("singletons", () => {
      it("are created with the dataset, from their defaults", async () => {
        const ds = await dataset();
        expect((await ds.query({ query: "shop.settings" })).after).toMatchObject([{ currency: "EUR" }]);
      });

      it("refuse a dataset their defaults cannot build", async () => {
        const yaml = header(
          `schemas:\n  - name: a\n    is_root:\n    singleton:\n    properties:\n      - name: p\n        type: string\n        mandatory:`,
        );
        expect(await codeOf(creating(yaml))).toBe("constraint_violation");
      });
    });
  });
}
