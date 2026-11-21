import { describe, expect, it } from "vitest";
import { exportSheets, importSheets } from "../src/index.js";
import { all, seed, setup } from "./helpers.js";

describe("export then import", () => {
  it("rebuilds a dataset from its own sheets, in an empty one, with the same export", async () => {
    const { dataset, fresh } = await setup();
    await seed(dataset);
    await dataset.run("carbon/update_line_footprint", { id: "Paris / Line 1", co2: 42, label: { fr: "Faible", en: "Low" } });
    const exported = await exportSheets(dataset);

    const copy = await fresh();
    const report = await importSheets(copy, exported.sheets);
    expect(report.ok).toBe(true);
    expect(report.refused).toBe(0);
    expect(report.created).toBe(7); // 2 countries, 3 cities, 2 lines
    expect((await exportSheets(copy)).sheets).toEqual(exported.sheets);
  });

  it("imports the sheets of a dataset into itself as unchanged rows", async () => {
    const { dataset } = await setup();
    await seed(dataset);
    await dataset.run("carbon/update_line_footprint", { id: "Paris / Line 1", co2: 42 });
    const before = JSON.stringify([await all(dataset, "city"), await all(dataset, "line"), await all(dataset, "country")]);
    const report = await importSheets(dataset, (await exportSheets(dataset)).sheets);
    expect(report.rows.filter((r) => r.status === "update")).toEqual([]);
    expect(report).toMatchObject({ ok: true, created: 0, updated: 0, unchanged: 7 });
    expect(JSON.stringify([await all(dataset, "city"), await all(dataset, "line"), await all(dataset, "country")])).toBe(before);
  });

  it("keeps the two entities of the same name apart through the round trip", async () => {
    const { dataset, fresh } = await setup();
    await seed(dataset);
    const copy = await fresh();
    await importSheets(copy, (await exportSheets(dataset)).sheets);
    const lines = await all(copy, "line");
    expect(lines.map((l) => l.name)).toEqual(["Line 1", "Line 1"]);
    expect(new Set(lines.map((l) => l.city)).size).toBe(2);
  });

  it("round trips into a dataset with other languages for what the sheet writes", async () => {
    const { dataset } = await setup();
    await seed(dataset);
    const { sheets } = await exportSheets(dataset);
    const other = await setup({ languages: ["en", "fr"] });
    const report = await importSheets(other.dataset, sheets);
    expect(report.ok).toBe(true);
    // the names were written in French and English: nothing is lost, only the source language differs
    const countries = await all(other.dataset, "country");
    expect(countries.map((c) => c.name.fr).sort()).toEqual(["Allemagne", "France"]);
  });
});
