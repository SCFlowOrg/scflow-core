import { describe, expect, it } from "vitest";
import { importSheets, SpreadsheetError, type Sheet } from "../src/index.js";
import { all, seed, setup } from "./helpers.js";

const sheet = (name: string, rows: Sheet["rows"], columns?: string[]): Sheet => ({
  name,
  columns: columns ?? [...new Set(rows.flatMap((r) => Object.keys(r)))],
  rows,
});

const names = async (dataset: Parameters<typeof all>[0], schema: string) => (await all(dataset, schema)).map((i) => (typeof i.name === "string" ? i.name : i.name.fr ?? i.name.en)).sort();

describe("importSheets: create and update by name", () => {
  it("creates what does not exist and updates what does, by name in its scope", async () => {
    const { dataset } = await setup();
    await seed(dataset);
    const report = await importSheets(dataset, [
      sheet("city", [
        { name: "Paris", country: "France", population: 2200000 }, // exists: an update
        { name: "Nice", country: "France", population: 340000 }, // new
      ]),
    ]);
    expect(report).toMatchObject({ ok: true, applied: true, dryRun: false, created: 1, updated: 1, unchanged: 0, refused: 0 });
    expect(report.rows.map((r) => [r.line, r.name, r.status])).toEqual([
      [2, "France / Paris", "update"],
      [3, "France / Nice", "create"],
    ]);
    expect(report.rows[0].changes).toEqual(["population"]);
    const cities = await all(dataset, "city");
    expect(cities.find((c) => c.name === "Paris")!.population).toBe(2200000);
    expect(cities.find((c) => c.name === "Paris")!.labels).toEqual(["capital", "north"]); // no column: untouched
    expect(cities.find((c) => c.name === "Nice")!.population).toBe(340000);
  });

  it("reports a row that changes nothing as unchanged and writes nothing for it", async () => {
    const { dataset } = await setup();
    await seed(dataset);
    const report = await importSheets(dataset, [sheet("city", [{ name: "Paris", country: "France", population: 2100000, labels: "capital; north" }])]);
    expect(report).toMatchObject({ ok: true, created: 0, updated: 0, unchanged: 1 });
    expect(report.rows[0]).toMatchObject({ status: "unchanged" });
  });

  it("keeps two entities of the same name under two parents apart", async () => {
    const { dataset } = await setup();
    await seed(dataset);
    const report = await importSheets(dataset, [
      sheet("line", [
        { name: "Line 1", city: "Paris", capacity: 20 }, // Paris / Line 1
        { name: "Line 1", city: "France / Lyon", capacity: 4 }, // Lyon / Line 1, the Lyon of France
        { name: "Line 1", city: "Germany / Lyon", capacity: 5 }, // another Line 1, in the Lyon of Germany: created
      ]),
    ]);
    expect(report.rows.map((r) => r.status)).toEqual(["update", "update", "create"]);
    const lines = await all(dataset, "line");
    expect(lines).toHaveLength(3);
    const capacities = lines.map((l) => l.capacity).sort((a, b) => a - b);
    expect(capacities).toEqual([4, 5, 20]);
  });

  it("refers to an entity by its name in any language, and by an id", async () => {
    const { dataset } = await setup();
    await seed(dataset);
    const germany = (await all(dataset, "country")).find((c) => c.name.en === "Germany")!;
    const report = await importSheets(dataset, [
      sheet("city", [
        { name: "Berlin", country: "Germany" }, // the English name
        { name: "Munich", country: "Allemagne" }, // the French name
        { name: "Bonn", country: germany.id }, // an id is accepted, never written
      ]),
    ]);
    expect(report).toMatchObject({ ok: true, created: 3 });
    expect(await names(dataset, "city")).toEqual(["Berlin", "Bonn", "Lyon", "Lyon", "Munich", "Paris"]);
  });

  it("writes a localized name, matches on any of its languages and completes the translations", async () => {
    const { dataset } = await setup();
    await seed(dataset);
    const report = await importSheets(dataset, [
      sheet("country", [
        { "name (en)": "France", "name (fr)": null, code: "FR" }, // only the English text: it is France, unchanged
        { "name (fr)": "Espagne", "name (en)": "Spain" }, // new
        { "name (en)": "Germany", "name (fr)": "Allemagne", code: "DE" }, // update
      ]),
    ]);
    expect(report.rows.map((r) => r.status)).toEqual(["unchanged", "create", "update"]);
    const countries = await all(dataset, "country");
    expect(countries.find((c) => c.name.en === "Spain")!.name).toEqual({ fr: "Espagne", en: "Spain" });
    // the empty French cell of the first row does not remove the French name: it identifies the entity
    expect(countries.find((c) => c.code === "FR")!.name).toEqual({ fr: "France", en: "France" });
  });

  it("takes a bare localized header as the source language", async () => {
    const { dataset } = await setup();
    const report = await importSheets(dataset, [sheet("country", [{ name: "Italie", code: "IT" }])]);
    expect(report.created).toBe(1);
    expect((await all(dataset, "country"))[0].name).toEqual({ fr: "Italie" });
  });

  it("clears a property whose cell is empty, leaves one whose column is absent, never removes a row", async () => {
    const { dataset } = await setup();
    await seed(dataset);
    await importSheets(dataset, [sheet("city", [{ name: "Paris", country: "France", population: null, labels: null }])]);
    const paris = (await all(dataset, "city")).find((c) => c.name === "Paris")!;
    expect(paris.population === null || paris.population === undefined || paris.population === 0).toBe(true);
    expect(paris.labels).toEqual([]);
    expect(await all(dataset, "city")).toHaveLength(3); // Lyon and Lyon stay: an import never deletes
  });

  it("reads numbers, booleans and lists from text cells", async () => {
    const { dataset } = await setup();
    await seed(dataset);
    const report = await importSheets(
      dataset,
      [sheet("city", [{ name: "Nice", country: "France", population: "340000", labels: "sea ;  sun;" }]), sheet("line", [{ name: "A", city: "Nice", capacity: "7.5", active: "TRUE" }])],
      { listSeparator: ";" },
    );
    expect(report.ok).toBe(true);
    expect((await all(dataset, "city")).find((c) => c.name === "Nice")).toMatchObject({ population: 340000, labels: ["sea", "sun"] });
    expect((await all(dataset, "line")).find((l) => l.name === "A")).toMatchObject({ capacity: 7.5, active: true });
  });

  it("takes the separator of lists given", async () => {
    const { dataset } = await setup();
    await importSheets(dataset, [sheet("country", [{ name: "X" }]), sheet("city", [{ name: "Y", country: "X", labels: "a; b | c" }])], { listSeparator: "|" });
    expect((await all(dataset, "city"))[0].labels).toEqual(["a; b", "c"]);
  });

  it("accepts the columns in any order and the sheet by its qualified name", async () => {
    const { dataset } = await setup();
    const report = await importSheets(dataset, [{ name: "plants.country", columns: ["code", "name (en)", "name (fr)"], rows: [{ code: "SE", "name (fr)": "Suède", "name (en)": "Sweden" }] }]);
    expect(report.ok).toBe(true);
  });
});

describe("importSheets: the order of writes", () => {
  it("writes parents before the entities that need them, whichever order the sheets come in", async () => {
    const { dataset } = await setup();
    const report = await importSheets(dataset, [
      sheet("line", [{ name: "L1", city: "Lyon", capacity: 1 }]),
      sheet("city", [{ name: "Lyon", country: "France" }]),
      sheet("country", [{ "name (fr)": "France", "name (en)": "France" }]),
    ]);
    expect(report).toMatchObject({ ok: true, created: 3 });
    expect(report.order).toEqual(["country", "city", "line"]);
    expect(await all(dataset, "line")).toHaveLength(1);
  });

  it("writes a row after the row of its own sheet it refers to", async () => {
    const { dataset } = await setup();
    const report = await importSheets(dataset, [
      sheet("node", [
        { name: "child", next: "parent" },
        { name: "parent", next: null },
      ]),
    ]);
    expect(report).toMatchObject({ ok: true, created: 2 });
    expect(report.rows.map((r) => r.name)).toEqual(["child", "parent"]);
  });

  it("writes an optional relation that makes a cycle after the creations", async () => {
    const { dataset } = await setup();
    const report = await importSheets(dataset, [
      sheet("node", [
        { name: "a", next: "b" },
        { name: "b", next: "a" },
      ]),
    ]);
    expect(report.rows.map((r) => r.reason)).toEqual([undefined, undefined]);
    expect(report).toMatchObject({ ok: true, created: 2 });
    const nodes = await all(dataset, "node");
    const a = nodes.find((n) => n.name === "a")!;
    const b = nodes.find((n) => n.name === "b")!;
    expect([a.next, b.next]).toEqual([b.id, a.id]);
  });

  it("refuses a cycle of mandatory relations, and names its rows", async () => {
    const { dataset } = await setup();
    const report = await importSheets(dataset, [
      sheet("pair", [
        { name: "x", partner: "y" },
        { name: "y", partner: "x" },
      ]),
    ]);
    expect(report.ok).toBe(false);
    expect(report.applied).toBe(false);
    expect(report.rows.map((r) => r.status)).toEqual(["refused", "refused"]);
    expect(report.rows[0]).toMatchObject({ code: "dependency_cycle" });
    expect(report.rows[0].reason).toContain("x");
    expect(report.rows[0].reason).toContain("y");
    expect(await all(dataset, "pair")).toHaveLength(0);
  });
});

describe("importSheets: all or nothing", () => {
  it("refuses everything when one row fails, and lists every row with its reason", async () => {
    const { dataset } = await setup();
    await seed(dataset);
    const before = JSON.stringify(await all(dataset, "city"));
    const report = await importSheets(dataset, [
      sheet("city", [
        { name: "Nice", country: "France" }, // fine
        { name: "Lille", country: "Atlantis" }, // no such country
        { name: "Brest", country: "France", population: "many" }, // not a number
        { name: "", country: "France" }, // no name
        { name: "Metz" }, // a mandatory relation missing
      ]),
    ]);
    expect(report).toMatchObject({ ok: false, applied: false, created: 1, refused: 4 });
    expect(report.rows.map((r) => [r.line, r.status, r.code])).toEqual([
      [2, "create", undefined],
      [3, "refused", "unresolved_reference"],
      [4, "refused", "invalid_value"],
      [5, "refused", "missing_name"],
      [6, "refused", "missing_required"],
    ]);
    expect(report.rows[1].reason).toContain("Atlantis");
    expect(report.rows[2].reason).toContain("population");
    expect(JSON.stringify(await all(dataset, "city"))).toBe(before); // Nice was not written
  });

  it("refuses an ambiguous reference with the qualified names of the candidates", async () => {
    const { dataset } = await setup();
    await seed(dataset);
    const report = await importSheets(dataset, [sheet("line", [{ name: "B", city: "Lyon" }])]);
    expect(report.ok).toBe(false);
    expect(report.rows[0]).toMatchObject({ status: "refused", code: "ambiguous_reference" });
    expect(report.rows[0].reason).toContain("Allemagne / Lyon");
    expect(report.rows[0].reason).toContain("France / Lyon");
  });

  it("refuses two rows that are the same entity", async () => {
    const { dataset } = await setup();
    const report = await importSheets(dataset, [sheet("country", [{ "name (fr)": "Chine" }, { "name (fr)": "Chine" }])]);
    expect(report.rows.map((r) => r.status)).toEqual(["create", "refused"]);
    expect(report.rows[1]).toMatchObject({ code: "duplicate_row" });
    expect(report.rows[1].reason).toContain("line 2");
  });

  it("refuses an unknown sheet, an unknown column and a column given twice as errors of the sheet", async () => {
    const { dataset } = await setup();
    const report = await importSheets(dataset, [
      sheet("planet", [{ name: "Mars" }]),
      sheet("city", [{ name: "Nice", country: "France", colour: "blue" }]),
      { name: "country", columns: ["name (fr)", "name (fr)"], rows: [{ "name (fr)": "A" }] },
      sheet("country", [{ "name (xx)": "A" }]),
    ]);
    expect(report.ok).toBe(false);
    expect(report.errors.map((e) => [e.sheet, e.code])).toEqual([
      ["planet", "unknown_sheet"],
      ["city", "unknown_column"],
      ["country", "duplicate_column"],
      ["country", "unknown_column"],
      ["country", "missing_name"], // that last sheet has no usable name column either
    ]);
    expect(report.applied).toBe(false);
  });

  it("refuses a row a rule of the model refuses, and writes nothing", async () => {
    const { dataset } = await setup();
    await seed(dataset);
    const report = await importSheets(dataset, [sheet("line", [{ name: "Neg", city: "Paris", capacity: -3 }])]);
    expect(report).toMatchObject({ ok: false, applied: false });
    expect(report.rows[0]).toMatchObject({ status: "refused", code: "rule_violation" });
    expect(report.rows[0].reason).toContain("capacity_not_negative");
    expect(await all(dataset, "line")).toHaveLength(2);
  });

  it("refuses a row whose names match two entities", async () => {
    const { dataset } = await setup();
    await seed(dataset);
    const report = await importSheets(dataset, [sheet("country", [{ "name (fr)": "France", "name (en)": "Germany" }])]);
    expect(report.ok).toBe(false);
    expect(report.rows[0]).toMatchObject({ status: "refused", code: "ambiguous_reference" });
    expect(report.rows[0].reason).toContain("France");
    expect(report.rows[0].reason).toContain("Allemagne");
  });

  it("refuses a write the model offers no action for", async () => {
    const { dataset } = await setup();
    const report = await importSheets(dataset, [sheet("fixed", [{ name: "x" }])]);
    expect(report.rows[0]).toMatchObject({ status: "refused", code: "no_action" });
  });
});

describe("importSheets: dry run and transaction", () => {
  it("says what would be created, updated and refused, and writes nothing", async () => {
    const { dataset } = await setup();
    await seed(dataset);
    const before = JSON.stringify([await all(dataset, "city"), await all(dataset, "line")]);
    const report = await importSheets(
      dataset,
      [sheet("city", [{ name: "Nice", country: "France" }, { name: "Paris", country: "France", population: 1 }]), sheet("line", [{ name: "Neg", city: "Paris", capacity: -1 }])],
      { dryRun: true },
    );
    expect(report).toMatchObject({ dryRun: true, applied: false });
    expect(report.rows.map((r) => r.status)).toEqual(["create", "update", "refused"]);
    expect(report.rows[2].code).toBe("rule_violation"); // the rules are checked too
    expect(JSON.stringify([await all(dataset, "city"), await all(dataset, "line")])).toBe(before);
  });

  it("a dry run of a good import reports it as ok and leaves the dataset as it was", async () => {
    const { dataset } = await setup();
    const report = await importSheets(dataset, [sheet("country", [{ "name (fr)": "Italie" }])], { dryRun: true });
    expect(report).toMatchObject({ ok: true, applied: false, dryRun: true, created: 1 });
    expect(await all(dataset, "country")).toHaveLength(0);
  });

  it("is one transaction: one undo takes the whole import back", async () => {
    const { dataset } = await setup();
    await seed(dataset);
    const report = await importSheets(dataset, [
      sheet("country", [{ "name (fr)": "Italie" }]),
      sheet("city", [{ name: "Rome", country: "Italie" }, { name: "Paris", country: "France", population: 5 }]),
    ]);
    expect(report).toMatchObject({ ok: true, created: 2, updated: 1 });
    expect(report.delta).toBeDefined();
    await dataset.begin("undo");
    await dataset.revert(report.delta as never);
    await dataset.commit();
    expect(await all(dataset, "country")).toHaveLength(2);
    expect((await all(dataset, "city")).find((c) => c.name === "Paris")!.population).toBe(2100000);
    expect(await all(dataset, "city")).toHaveLength(3);
  });

  it("joins a transaction the caller opened, and does not end it", async () => {
    const { dataset } = await setup();
    await dataset.begin("mine");
    const report = await importSheets(dataset, [sheet("country", [{ "name (fr)": "Italie" }])], { transaction: "caller" });
    expect(report).toMatchObject({ ok: true, applied: true });
    await dataset.rollback();
    expect(await all(dataset, "country")).toHaveLength(0);
  });

  it("cannot dry run in a transaction of the caller", async () => {
    const { dataset } = await setup();
    await expect(importSheets(dataset, [], { dryRun: true, transaction: "caller" })).rejects.toBeInstanceOf(SpreadsheetError);
  });
});

describe("importSheets: facets", () => {
  it("writes the columns of a facet through the action of the facet", async () => {
    const { dataset } = await setup();
    await seed(dataset);
    const report = await importSheets(dataset, [
      sheet("line", [
        { name: "Line 1", city: "Paris", "carbon.co2": 7, "carbon.label (fr)": "Bas", "carbon.label (en)": "Low" }, // an update of an existing line
        { name: "N", city: "Paris", capacity: 1, "carbon.co2": 9 }, // a new line with a facet value
      ]),
    ]);
    expect(report).toMatchObject({ ok: true, created: 1, updated: 1 });
    expect(report.rows[0].changes).toEqual(expect.arrayContaining(["carbon.co2", "carbon.label"]));
    const lines = await all(dataset, "line");
    expect(lines.find((l) => l.name === "Line 1" && l.carbon)!.carbon).toMatchObject({ co2: 7, label: { fr: "Bas", en: "Low" } });
    expect(lines.find((l) => l.name === "N")!.carbon).toMatchObject({ co2: 9 });
  });
});
