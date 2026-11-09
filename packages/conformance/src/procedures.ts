import { describe, expect, it } from "vitest";
import { readModuleManifest, resolveClockPlaceholders, runProcedure } from "@scfloworg/core";
import { createApiSession, initDataset, runCommand, queryDataset } from "@scfloworg/core/testing";
import type { ModuleManifest, UpgradeModuleOptions } from "@scfloworg/core";
import type { AuthoredCommand, ProcedureHost } from "@scfloworg/core";

/** Runs a module upgrade through a session of its own. */
const upgradeModule = (locator: string, manifest: ModuleManifest, options?: UpgradeModuleOptions) =>
  createApiSession().upgradeModule(locator, manifest, options);

type Row = Record<string, unknown>;

const shopModule = (version: string, schemas: string, migrations = "") => `
name: acme:shop
namespace: shop
version: ${version}
mcl: ^1.0
title: Shop
schemas:
${schemas}
${migrations}
`;

const v1Schemas = `
  - name: site
    shared_by_name:
    is_root:
    properties:
      - name: name
        type: identifier
      - name: label
        type: string
      - name: legacy
        type: string
  - name: stock
    is_root:
    properties:
      - name: site
        type: site
      - name: count
        type: integer
`;

/**
 * Procedures, per `model-command-language.md`, Script, and declared
 * migrations, per `meta-model.md`, Model Upgrade: piece 5.3 of phase C.
 */
export function procedureCases(formatPrefix: string, newLocator: () => string): void {
  async function dataset(): Promise<string> {
    const locator = newLocator();
    await initDataset(locator, "procedures", { modules: [readModuleManifest(shopModule("1.0.0", v1Schemas))] });
    return locator;
  }

  function host(locator: string, calls: Array<{ id: string; params: unknown }> = []): ProcedureHost {
    return {
      runCommand: (command: AuthoredCommand) => runCommand(locator, command),
      async call(id: string, params: unknown) {
        calls.push({ id, params });
        return { called: id };
      },
    };
  }
  const codeOf = (promise: Promise<unknown>) => promise.then(() => "ok", (e: { code?: string }) => e.code);

  describe(`procedure conformance — ${formatPrefix}`, () => {
    it("reads its parameters, names results with as, and gives the result of its last step or its result", async () => {
      const locator = await dataset();
      const procedure = {
        parameters: { type: "object", properties: { name: { type: "string" }, label: { type: "string" } } },
        commands: [
          { create: "shop.site", input: { name: "${params.name}", label: "${params.label}", legacy: "${params.missing}" }, as: "site" },
          { create: "shop.stock", input: { site: "${site.after.0.name}", count: 3 }, as: "stock" },
        ],
        result: "${site.after.0}",
      };
      const result = await runProcedure(procedure, { name: "paris", label: "Paris" }, host(locator));
      expect(result).toMatchObject({ name: "paris", label: "Paris", legacy: "" });
      const last = await runProcedure({ commands: [{ query: "shop.stock" }] }, {}, host(locator));
      expect((last as Row).after).toMatchObject([{ site: "paris", count: 3 }]);
    });

    it("skips a step whose when does not hold, loops with each, and calls actions", async () => {
      const locator = await dataset();
      const calls: Array<{ id: string; params: unknown }> = [];
      await runProcedure(
        {
          commands: [
            { each: "${params.names}", as: "n", do: [{ create: "shop.site", input: { name: "${n}" } }] },
            { call: "shop/notify", with: { site: "${params.names.0}" }, when: { "params.notify": true }, as: "notified" },
            { call: "shop/audit", with: { all: "${params.names}" }, when: { "params.notify": { ne: true } } },
          ],
        },
        { names: ["a", "b"], notify: false },
        host(locator, calls),
      );
      expect(((await runCommand(locator, { query: "shop.site" })).after as Row[]).map((r) => r.name).sort()).toEqual(["a", "b"]);
      expect(calls).toEqual([{ id: "shop/audit", params: { all: ["a", "b"] } }]);
    });

    it("refuses the whole procedure with fail, and a step of another shape", async () => {
      const locator = await dataset();
      const failed = await runProcedure(
        { commands: [{ fail: "site ${params.name} is closed", when: { "params.closed": true } }] },
        { name: "x", closed: true },
        host(locator),
      ).catch((e: Error) => e) as Error;
      expect(failed).toMatchObject({ code: "procedure_failed" });
      expect(failed.message).toContain("site x is closed");
      expect(await codeOf(runProcedure({ commands: [{ create: "shop.site", input: {}, call: "shop/x" }] }, {}, host(locator)))).toBe("invalid_script_step");
      expect(await codeOf(runProcedure({ commands: [{ each: "${params.names}" }] }, { names: [] }, host(locator)))).toBe("invalid_script_step");
      expect(await codeOf(runProcedure({ commands: [{ query: "shop.site", as: "s" }, { fail: "${nope.after}" }] }, {}, host(locator)))).toBe("unknown_reference");
    });

    it("leaves a placeholder reading the clock to its host, in a command and in a call", async () => {
      const commands: unknown[] = [];
      const calls: unknown[] = [];
      await runProcedure(
        {
          commands: [
            { create: "shop.site", input: { name: "${params.name}", at: "${now()}", note: "${params.name} in ${year(now())}" } },
            { query: "shop.site", filters: { at: { lt: "${now()}" } } },
            { call: "shop/notify", with: { at: "${now()}" } },
          ],
        },
        { name: "paris" },
        {
          runCommand: async (command) => { commands.push(command); return { after: [] } as never; },
          call: async (_id, params) => { calls.push(params); return null; },
        },
      );
      expect(commands).toEqual([
        { create: "shop.site", input: { name: "paris", at: "${now()}", note: "paris in ${year(now())}" } },
        { query: "shop.site", filters: { at: { lt: "${now()}" } } },
      ]);
      expect(calls).toEqual([{ at: "${now()}" }]);
    });

    it("resolves only the clock of a command with resolveClockPlaceholders", () => {
      const command = { create: "shop.site", input: { at: "${now()}", name: "${other}" }, filters: { label: { eq: "${this.name}" } } };
      const resolved = resolveClockPlaceholders(command as never) as unknown as { input: Row; filters: Row };
      expect(resolved.input.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(resolved.input.name).toBe("${other}");
      expect(resolved.filters).toEqual({ label: { eq: "${this.name}" } });
      expect(command.input.at).toBe("${now()}");
    });

    it("leaves a default_value of a schema input for the instances it constructs", () => {
      const input = [{ name: "stamp", properties: [{ name: "at", type: "date_time", default_value: "${now()}" }] }];
      const resolved = resolveClockPlaceholders({ create: "schema", input } as never) as unknown as { input: unknown };
      expect(resolved.input).toEqual(input);
    });

    it("leaves a path on this in its filters for the command to resolve per instance", async () => {
      const locator = await dataset();
      await runCommand(locator, { create: "shop.site", input: [{ name: "a", label: "a" }, { name: "b", label: "B" }] });
      const result = await runProcedure({ commands: [{ query: "shop.site", filters: { label: { eq: "${this.name}" } } }] }, {}, host(locator));
      expect(((result as Row).after as Row[]).map((r) => r.name)).toEqual(["a"]);
    });
  });

  describe(`declared migration conformance — ${formatPrefix}`, () => {
    const v2Schemas = `
  - name: place
    shared_by_name:
    is_root:
    properties:
      - name: name
        type: identifier
      - name: title
        type: string
  - name: stock
    is_root:
    properties:
      - name: site
        type: place
      - name: count
        type: integer
      - name: unit
        type: string
        default_value: piece
`;
    const v2Migrations = `
migrations:
  - to: 2.0.0
    rename_schema: { from: site, to: place }
  - to: 2.0.0
    rename_property: { schema: place, from: label, to: title }
  - to: 2.0.0
    delete_property: { schema: place, property: legacy }
`;

    it("runs the declared migrations in version order, then the automatic part, in one step", async () => {
      const locator = await dataset();
      await runCommand(locator, { create: "shop.site", input: [{ name: "paris", label: "Paris", legacy: "old" }] });
      await runCommand(locator, { create: "shop.stock", input: [{ site: "paris", count: 2 }] });
      const v2 = readModuleManifest(shopModule("2.0.0", v2Schemas, v2Migrations));
      await upgradeModule(locator, v2);
      expect((await runCommand(locator, { query: "shop.place" })).after).toEqual([{ name: "paris", title: "Paris" }]);
      expect((await runCommand(locator, { query: "shop.stock" })).after).toMatchObject([{ site: "paris", count: 2, unit: "piece" }]);
      const info = (await queryDataset(locator)) as Row;
      expect((info.modules as Row[])[0]).toMatchObject({ module: "acme:shop", version: "2.0.0" });
    });

    it("runs a migration the host has code for through the session of the upgrade", async () => {
      const locator = await dataset();
      await runCommand(locator, { create: "shop.stock", input: [{ count: 2 }, { count: 5 }] });
      const v11 = readModuleManifest(shopModule("1.1.0", v1Schemas, `migrations:\n  - to: 1.1.0\n    body: double\n`));
      const session = createApiSession();
      await session.upgradeModule(locator, v11, {
        migrate: async () => {
          const stock = (await session.runCommand(locator, { query: "shop.stock" })) as { after: Row[] };
          for (const s of stock.after) await session.runCommand(locator, { update: "shop.stock", filters: { id: s.id }, input: { count: (s.count as number) * 2 } });
          return true;
        },
      });
      const counts = ((await runCommand(locator, { query: "shop.stock" })).after as Row[]).map((r) => r.count).sort();
      expect(counts).toEqual([10, 4].sort());
    });

    it("refuses an incompatible change that no migration covers, and a body the host does not give, changing nothing", async () => {
      const locator = await dataset();
      await runCommand(locator, { create: "shop.site", input: [{ name: "paris", label: "Paris" }] });
      const renamedNoMigration = readModuleManifest(shopModule("2.0.0", v2Schemas));
      expect(await codeOf(upgradeModule(locator, renamedNoMigration))).toBe("incompatible_upgrade");
      const withBody = readModuleManifest(shopModule("1.1.0", v1Schemas, `migrations:\n  - to: 1.1.0\n    body: double\n`));
      expect(await codeOf(upgradeModule(locator, withBody))).toBe("incompatible_upgrade");
      expect(await codeOf(upgradeModule(locator, readModuleManifest(shopModule("0.9.0", v1Schemas))))).toBe("constraint_violation");
      expect((await runCommand(locator, { query: "shop.site" })).after).toMatchObject([{ name: "paris", label: "Paris" }]);
    });

    it("rolls a rename back when the rules of the new version refuse it", async () => {
      const locator = await dataset();
      await runCommand(locator, { create: "shop.site", input: [{ name: "paris", label: "Paris" }] });
      const strict = readModuleManifest(
        shopModule(
          "2.0.0",
          v2Schemas.replace(
            "  - name: stock\n",
            "    checks:\n      - name: place_is_named_lyon\n        require: { title: { eq: Lyon } }\n  - name: stock\n",
          ),
          v2Migrations,
        ),
      );
      const error = (await upgradeModule(locator, strict).catch((e) => e)) as { code: string; details: { violations: Row[] } };
      expect(error.code).toBe("rule_violation");
      expect(error.details.violations.map((v) => v.key)).toEqual(["paris"]);
      expect((await runCommand(locator, { query: "shop.site" })).after).toMatchObject([{ name: "paris", label: "Paris" }]);
      expect(((await queryDataset(locator)) as Row).modules as Row[]).toMatchObject([{ version: "1.0.0" }]);
    });

    it("rolls a failed body back", async () => {
      const locator = await dataset();
      await runCommand(locator, { create: "shop.stock", input: [{ count: 2 }] });
      const v11 = readModuleManifest(shopModule("1.1.0", v1Schemas, `migrations:\n  - to: 1.1.0\n    body: broken\n`));
      const session = createApiSession();
      await expect(
        session.upgradeModule(locator, v11, {
          migrate: async () => {
            await session.runCommand(locator, { update: "shop.stock", input: { count: 9 } });
            throw new Error("broken body");
          },
        }),
      ).rejects.toThrow("broken body");
      expect((await runCommand(locator, { query: "shop.stock" })).after).toMatchObject([{ count: 2 }]);
      const info = (await queryDataset(locator)) as Row;
      expect((info.modules as Row[])[0]).toMatchObject({ version: "1.0.0" });
    });
  });
}
