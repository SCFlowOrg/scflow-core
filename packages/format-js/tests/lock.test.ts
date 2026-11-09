import { createApiSession, registerPersistentFormat } from "@scfloworg/core/testing";
import type { TransientObject } from "@scfloworg/core";
import { describe, expect, it } from "vitest";
import { createJsPersistenceInterface } from "../src/index.js";

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("js lock(rest)", () => {
  it("is provided by the format", () => {
    expect(typeof createJsPersistenceInterface().lock).toBe("function");
  });

  it("admits one holder at a time and serves callers in arrival order", async () => {
    const impl = createJsPersistenceInterface();
    const lock = impl.lock as NonNullable<typeof impl.lock>;
    let holders = 0;
    let maxHolders = 0;
    const order: number[] = [];

    await Promise.all(
      [1, 2, 3, 4, 5].map(async (n) => {
        const release = await lock("d1");
        holders += 1;
        maxHolders = Math.max(maxHolders, holders);
        order.push(n);
        await tick();
        holders -= 1;
        await release();
      }),
    );

    expect(maxHolders).toBe(1);
    expect(order).toEqual([1, 2, 3, 4, 5]);
  });

  it("keeps a second caller waiting until the first releases", async () => {
    const impl = createJsPersistenceInterface();
    const lock = impl.lock as NonNullable<typeof impl.lock>;
    const first = await lock("d1");

    let secondHeld = false;
    const second = lock("d1").then((release) => {
      secondHeld = true;
      return release;
    });
    for (let i = 0; i < 5; i++) await tick();
    expect(secondHeld).toBe(false);

    await first();
    await (await second)();
    expect(secondHeld).toBe(true);
  });

  it("does not make a different rest wait", async () => {
    const impl = createJsPersistenceInterface();
    const lock = impl.lock as NonNullable<typeof impl.lock>;
    const first = await lock("d1");

    const other = await lock("d2");
    await other();
    await first();
  });

  it("releasing twice does not release the next holder's lock", async () => {
    const impl = createJsPersistenceInterface();
    const lock = impl.lock as NonNullable<typeof impl.lock>;
    const first = await lock("d1");
    const secondPending = lock("d1");
    await first();
    const second = await secondPending;

    await first();
    let thirdHeld = false;
    const third = lock("d1").then((release) => {
      thirdHeld = true;
      return release;
    });
    for (let i = 0; i < 5; i++) await tick();
    expect(thirdHeld).toBe(false);

    await second();
    await (await third)();
  });

  it("two ApiSessions writing one dataset lose no version increment", async () => {
    const impl = createJsPersistenceInterface();
    registerPersistentFormat(impl);
    await impl.createDataset("lock-d1", "Start");
    const locator = `${impl.name}:lock-d1`;
    const a = createApiSession();
    const b = createApiSession();
    const rename = (name: string) => ({ kind: "update" as const, schema: "dataset", input: { name } });

    await Promise.all([
      ...[1, 2, 3, 4, 5].map((i) => a.runCommand(locator, rename(`a${i}`))),
      ...[1, 2, 3, 4, 5].map((i) => b.runCommand(locator, rename(`b${i}`))),
    ]);

    const info = (await impl.getDataset("lock-d1")) as TransientObject;
    expect(info.data_minor_version).toBe(10);
  });
});
