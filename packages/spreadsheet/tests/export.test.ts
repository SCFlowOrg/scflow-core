import { describe, expect, it } from "vitest";
import { exportSheets, SpreadsheetError } from "../src/index.js";
import { seed, setup } from "./helpers.js";

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

describe("exportSheets", () => {
  it("writes one sheet per entity type, named or not", async () => {
    const { dataset } = await setup();
    const { sheets, skipped, languages } = await exportSheets(dataset);
    expect(languages).toEqual(["fr", "en"]);
    expect(sheets.map((s) => s.name)).toEqual(["country", "city", "line", "pair", "node", "fixed", "box", "link", "comment", "memo"]);
    expect(sheets.every((s) => s.schema === `plants.${s.name}`)).toBe(true);
    expect(skipped).toEqual([]);
  });

  it("takes the columns from the schema, name first, one per language for a localized property", async () => {
    const { dataset } = await setup();
    const { sheets } = await exportSheets(dataset);
    const by = Object.fromEntries(sheets.map((s) => [s.name, s.columns]));
    expect(by.country).toEqual(["name (fr)", "name (en)", "code"]);
    expect(by.city).toEqual(["name", "country", "population", "labels"]);
    // a facet adds its columns, qualified by its namespace
    expect(by.line).toEqual(["name", "city", "capacity", "active", "remark (fr)", "remark (en)", "carbon.co2", "carbon.label (fr)", "carbon.label (en)"]);
  });

  it("leaves out the facet when the dataset does not use its module", async () => {
    const { dataset } = await setup({ facet: false });
    const { sheets } = await exportSheets(dataset);
    expect(sheets.find((s) => s.name === "line")!.columns).not.toContain("carbon.co2");
  });

  it("writes a relation as the reference of its target, qualified only when two share the name", async () => {
    const { dataset } = await setup();
    await seed(dataset);
    const { sheets } = await exportSheets(dataset);
    const cities = sheets.find((s) => s.name === "city")!.rows;
    expect(cities.map((r) => [r.name, r.country])).toEqual([
      ["Lyon", "Allemagne"],
      ["Lyon", "France"],
      ["Paris", "France"],
    ]);
    const lines = sheets.find((s) => s.name === "line")!.rows;
    // Paris is unambiguous; Lyon exists in two countries, so the line gives the country, in the source language
    expect(lines.map((r) => r.city)).toEqual(["France / Lyon", "Paris"]);
  });

  it("writes every language of a localized text, the first column being the source language, and a list in one cell", async () => {
    const { dataset } = await setup();
    await seed(dataset);
    const { sheets } = await exportSheets(dataset);
    const countries = sheets.find((s) => s.name === "country")!.rows;
    expect(countries[0]).toEqual({ "name (fr)": "Allemagne", "name (en)": "Germany", code: null });
    expect(sheets.find((s) => s.name === "city")!.rows.find((r) => r.name === "Paris")!.labels).toBe("capital; north");
    const paris = sheets.find((s) => s.name === "line")!.rows.find((r) => r.city === "Paris")!;
    expect(paris).toMatchObject({ capacity: 12.5, active: true, "remark (fr)": "Rapide", "remark (en)": "Fast" });
  });

  it("never writes an id", async () => {
    const { dataset } = await setup();
    await seed(dataset);
    const { sheets } = await exportSheets(dataset);
    expect(JSON.stringify(sheets)).not.toMatch(UUID);
    expect(sheets.flatMap((s) => s.columns)).not.toContain("id");
  });

  it("writes the values a facet holds", async () => {
    const { dataset } = await setup();
    await seed(dataset);
    await dataset.run("carbon/update_line_footprint", { id: "Paris / Line 1", co2: 42, label: { fr: "Faible", en: "Low" } });
    const { sheets } = await exportSheets(dataset);
    const line = sheets.find((s) => s.name === "line")!.rows.find((r) => r.city === "Paris")!;
    expect(line).toMatchObject({ "carbon.co2": 42, "carbon.label (fr)": "Faible", "carbon.label (en)": "Low" });
  });

  it("takes the separator of lists, and refuses a value that contains it", async () => {
    const { dataset } = await setup();
    await seed(dataset);
    const { sheets } = await exportSheets(dataset, { listSeparator: "|", schemas: ["city"] });
    expect(sheets.map((s) => s.name)).toEqual(["city"]);
    expect(sheets[0].rows.find((r) => r.name === "Paris")!.labels).toBe("capital| north");
    await dataset.run("plants/update_city", { id: "Paris", labels: ["a;b"] });
    await expect(exportSheets(dataset, { schemas: ["city"] })).rejects.toBeInstanceOf(SpreadsheetError);
  });

  it("refuses a sheet that does not exist", async () => {
    const { dataset } = await setup();
    await expect(exportSheets(dataset, { schemas: ["nothing"] })).rejects.toMatchObject({ code: "unknown_sheet" });
  });

  it("writes the languages the dataset states", async () => {
    const { dataset } = await setup({ languages: ["de"] });
    expect((await exportSheets(dataset)).sheets[0].columns).toEqual(["name (de)", "code"]);
  });
});
