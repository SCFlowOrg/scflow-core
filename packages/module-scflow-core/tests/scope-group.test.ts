import { describe, expect, it } from "vitest";
import { setupActions as setup } from "./actions-helpers.js";

describe("the group of a scope", () => {
  it("is empty and first by default", async () => {
    const { run, query } = await setup();

    await run("scflow/create_scope", { name: "Make" });

    expect((await query("scope"))[0]).toMatchObject({ group: "", group_index: 1 });
  });

  it("is given when the scope is created", async () => {
    const { run, query } = await setup();

    await run("scflow/create_scope", { name: "Make", group: "EMEA", group_index: 3 });

    expect((await query("scope"))[0]).toMatchObject({ group: "EMEA", group_index: 3 });
  });

  it("is written by the generated update of the scope", async () => {
    const { run, query } = await setup();
    await run("scflow/create_scope", { name: "Make" });

    await run("scflow/update_scope", { id: "Make", group: "EMEA", group_index: 2 });

    expect((await query("scope"))[0]).toMatchObject({ group: "EMEA", group_index: 2 });
  });

  it("refuses an index below 1 and writes nothing", async () => {
    const { run, query } = await setup();
    await run("scflow/create_scope", { name: "Make" });

    await expect(run("scflow/update_scope", { id: "Make", group_index: 0 })).rejects.toThrow();

    expect((await query("scope"))[0]).toMatchObject({ group_index: 1 });
  });

  it("lets two scopes of a group share an index", async () => {
    const { run, query } = await setup();
    await run("scflow/create_scope", { name: "Make" });
    await run("scflow/create_scope", { name: "Deliver" });

    await run("scflow/update_scope", { id: "Make", group: "EMEA", group_index: 1 });
    await run("scflow/update_scope", { id: "Deliver", group: "EMEA", group_index: 1 });

    expect((await query("scope")).map((scope) => scope.group)).toEqual(["EMEA", "EMEA"]);
  });
});
