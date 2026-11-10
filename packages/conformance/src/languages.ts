import { describe, expect, it } from "vitest";
import { createEngine } from "@scfloworg/core";
import type { AuthoredCommand, Engine, PersistenceInterface } from "@scfloworg/core";

const ITEM = {
  name: "item",
  properties: [
    { name: "name", type: "identifier" },
    { name: "label", type: "localized_string" },
  ],
  shared_by_name: true,
};

/**
 * The `languages` of a dataset, `packages/core/docs/spec/meta-model.md#dataset`:
 * an ordered list of language codes with no duplicate, absent reading as `[]`,
 * written through `update` on `dataset`; it offers and expects, never forbids.
 */
export function languageCases(impl: PersistenceInterface, formatPrefix: string): void {
  describe("languages of a dataset", () => {
    let counter = 0;

    async function dataset(languages?: string[]): Promise<{ engine: Engine; locator: string }> {
      const engine = createEngine({ formats: [impl] });
      const locator = `${formatPrefix}:languages-${Date.now()}-${++counter}`;
      await engine.initDataset(locator, "languages", languages ? { languages } : {});
      const upgrade = await engine.createUpgradeLocator(locator);
      await engine.runCommand(upgrade, { create: "schema", input: [ITEM] } as unknown as AuthoredCommand);
      await engine.upgradeDataset(locator, upgrade);
      return { engine, locator };
    }

    const write = (engine: Engine, locator: string, command: AuthoredCommand) => engine.createActionSession().runCommand(locator, command);
    const set = (languages: unknown) => ({ update: "dataset", input: [{ languages }] }) as unknown as AuthoredCommand;
    const read = async (engine: Engine, locator: string) =>
      (((await engine.runCommand(locator, { query: "dataset" } as unknown as AuthoredCommand)).after[0]) as { languages?: string[] }).languages ?? [];
    const minor = async (engine: Engine, locator: string) => ((await engine.queryDataset(locator)) as { data_minor_version: number }).data_minor_version;

    it("reads as [] when absent, and a dataset without the list works as before", async () => {
      const { engine, locator } = await dataset();
      expect(await read(engine, locator)).toEqual([]);
      await engine.createActionSession().runCommand(locator, { create: "item", input: [{ name: "a", label: { fr: "A" } }] } as unknown as AuthoredCommand);
    });

    it("is seeded by initDataset and keeps its order", async () => {
      const { engine, locator } = await dataset(["fr", "en", "pt-BR"]);
      expect(await read(engine, locator)).toEqual(["fr", "en", "pt-BR"]);
    });

    it("is replaced as a whole by an update, which bumps the data version", async () => {
      const { engine, locator } = await dataset(["fr"]);
      const before = await minor(engine, locator);
      await write(engine, locator, set(["de", "fr"]));
      expect(await read(engine, locator)).toEqual(["de", "fr"]);
      expect(await minor(engine, locator)).toBe(before + 1);
    });

    it("refuses a duplicate, a bad code and a non-array, and changes nothing", async () => {
      const { engine, locator } = await dataset(["fr"]);
      for (const bad of [["en", "en"], ["english"], "en", [1]]) {
        await expect(write(engine, locator, set(bad))).rejects.toMatchObject({ code: "constraint_violation" });
      }
      expect(await read(engine, locator)).toEqual(["fr"]);
    });

    it("accepts an empty list", async () => {
      const { engine, locator } = await dataset(["fr"]);
      await write(engine, locator, set([]));
      expect(await read(engine, locator)).toEqual([]);
    });

    it("keeps a text in a language outside the list, and removing a language removes no text", async () => {
      const { engine, locator } = await dataset(["fr"]);
      await engine.createActionSession().runCommand(locator, { create: "item", input: [{ name: "a", label: { fr: "A", de: "A!" } }] } as unknown as AuthoredCommand);
      await write(engine, locator, set(["en"]));
      const item = (await engine.runCommand(locator, { query: "item" } as unknown as AuthoredCommand)).after[0] as { label: Record<string, string> };
      expect(item.label).toEqual({ fr: "A", de: "A!" });
    });

    it("joins a transaction and is undone with it", async () => {
      const { engine, locator } = await dataset(["fr"]);
      const session = engine.createActionSession();
      if (!(await session.supportsTransactions(locator))) return;
      const tx = await session.beginTransaction(locator);
      await session.runCommand(locator, set(["en", "fr"]));
      const prepared = await session.prepareTransaction(locator, tx);
      await session.commitTransaction(locator, tx);
      expect(prepared.changed).toBe(true);
      expect(await read(engine, locator)).toEqual(["en", "fr"]);
      const undo = await session.beginTransaction(locator);
      await session.revert(locator, prepared.delta);
      await session.commitTransaction(locator, undo);
      expect(await read(engine, locator)).toEqual(["fr"]);
    });

    it("rolls back with its transaction", async () => {
      const { engine, locator } = await dataset(["fr"]);
      const session = engine.createActionSession();
      if (!(await session.supportsTransactions(locator))) return;
      const tx = await session.beginTransaction(locator);
      await session.runCommand(locator, set(["en"]));
      await session.rollbackTransaction(locator, tx);
      expect(await read(engine, locator)).toEqual(["fr"]);
    });

    it("an update to the current list changes nothing", async () => {
      const { engine, locator } = await dataset(["fr"]);
      const before = await minor(engine, locator);
      await write(engine, locator, set(["fr"]));
      expect(await minor(engine, locator)).toBe(before);
    });

    it("is carried by a dump and a restore", async () => {
      const { engine, locator } = await dataset(["fr", "en"]);
      const dump = await engine.dumpDataset(locator, "json");
      const target = `${formatPrefix}:languages-restored-${Date.now()}-${++counter}`;
      await engine.restoreDataset(target, dump, "json");
      expect(await read(engine, target)).toEqual(["fr", "en"]);
    });
  });
}
