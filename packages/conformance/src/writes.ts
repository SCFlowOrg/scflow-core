import { describe, expect, it } from "vitest";
import { createEngine } from "@scfloworg/core";
import type { AuthoredCommand, Engine, PersistenceInterface } from "@scfloworg/core";

const TASK = { name: "task", properties: [{ name: "title", type: "string" }] };

const WRITE_REFUSED = { code: "write_outside_action" };
const SCRIPT_CREATE = { kind: "create", schema: "task", input: [{ title: "a" }] } as never;

/**
 * Writes and actions, `packages/core/docs/spec/typescript-reference-implementation.md`:
 * outside an action session the engine refuses a write of data, and lets
 * queries and the writes of the model pass.
 */
export function writeCases(impl: PersistenceInterface, formatPrefix: string): void {
  describe("writes outside an action", () => {
    let counter = 0;

    async function dataset(): Promise<{ engine: Engine; locator: string }> {
      const engine = createEngine({ formats: [impl] });
      const locator = `${formatPrefix}:write-outside-action-${++counter}`;
      await engine.initDataset(locator, "writes");
      const upgrade = await engine.createUpgradeLocator(locator);
      await engine.runCommand(upgrade, { create: "schema", input: [TASK] } as unknown as AuthoredCommand);
      await engine.upgradeDataset(locator, upgrade);
      return { engine, locator };
    }

    const create = { create: "task", input: [{ title: "a" }] } as unknown as AuthoredCommand;
    const update = { update: "task", input: [{ title: "b" }] } as unknown as AuthoredCommand;
    const remove = { delete: "task" } as unknown as AuthoredCommand;
    const query = { query: "task" } as unknown as AuthoredCommand;

    for (const [name, command] of [["create", create], ["update", update], ["delete", remove]] as const) {
      it(`refuses a ${name} through runCommand`, async () => {
        const { engine, locator } = await dataset();
        await expect(engine.runCommand(locator, command)).rejects.toMatchObject(WRITE_REFUSED);
      });
    }

    it("refuses a write in a script, and runs none of its commands", async () => {
      const { engine, locator } = await dataset();
      await expect(engine.runScript(locator, { commands: [query, create] })).rejects.toMatchObject(WRITE_REFUSED);
      expect((await engine.runCommand(locator, query)).after).toEqual([]);
    });

    it("refuses a write in a script session", async () => {
      const { engine, locator } = await dataset();
      const session = await engine.createScriptSession(locator);
      await expect(session.run(SCRIPT_CREATE)).rejects.toMatchObject(WRITE_REFUSED);
    });

    it("refuses a write through an ApiSession, in and out of a transaction", async () => {
      const { engine, locator } = await dataset();
      const session = engine.createApiSession();
      await expect(session.runCommand(locator, create)).rejects.toMatchObject(WRITE_REFUSED);
      await expect(session.runScript(locator, { commands: [create] })).rejects.toMatchObject(WRITE_REFUSED);
      const script = await session.createScriptSession(locator);
      await expect(script.run(SCRIPT_CREATE)).rejects.toMatchObject(WRITE_REFUSED);
      if (!(await session.supportsTransactions(locator))) return;
      const tx = await session.beginTransaction(locator);
      await expect(session.runCommand(locator, create)).rejects.toMatchObject(WRITE_REFUSED);
      await session.rollbackTransaction(locator, tx);
    });

    it("lets a query through, and an action session write", async () => {
      const { engine, locator } = await dataset();
      await engine.createActionSession().runCommand(locator, create);
      expect((await engine.createApiSession().runCommand(locator, query)).after).toHaveLength(1);
    });
  });
}
