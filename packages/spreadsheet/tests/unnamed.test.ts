import { describe, expect, it } from "vitest";
import { exportSheets, importSheets, type Sheet } from "../src/index.js";
import { all, seedLinks, setup } from "./helpers.js";

const sheet = (name: string, rows: Sheet["rows"]): Sheet => ({ name, columns: [...new Set(rows.flatMap((r) => Object.keys(r)))], rows });
const links = async (dataset: Parameters<typeof all>[0]) => all(dataset, "link");

describe("entities that have no name", () => {
  it("exports them: a relation to one is written as its label, and says which kind when it could be several", async () => {
    const { dataset } = await setup();
    await seedLinks(dataset);
    const a = (await links(dataset)).find((l) => l.weight === 1)!;
    await dataset.run("plants/create_comment", { about: a.id, text: { fr: "Lent", en: "Slow" } });
    await dataset.run("plants/create_comment", { about: (await all(dataset, "box")).find((b) => b.name === "A")!.id, text: { fr: "Début" } });
    const { sheets } = await exportSheets(dataset);
    const by = Object.fromEntries(sheets.map((s) => [s.name, s]));
    expect(by.link.columns).toEqual(["tags", "source", "target", "weight"]);
    expect(by.link.rows.map((r) => [r.source, r.target, r.weight])).toEqual([
      ["A", "B", 1],
      ["B", "C", 2],
    ]);
    // `about` can point at a box or a link: the reference says which
    expect(by.comment.rows.map((r) => r.about).sort()).toEqual(["box: A", "link: A | B"]);
    expect(JSON.stringify(sheets)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it("finds a row by the values of its unique group: the same key is an update, a new key a creation", async () => {
    const { dataset } = await setup();
    await seedLinks(dataset);
    const report = await importSheets(dataset, [
      sheet("link", [
        { source: "A", target: "B", weight: 10 }, // exists: its weight changes
        { source: "B", target: "C", weight: 2 }, // exists: nothing changes
        { source: "C", target: "A", weight: 3 }, // new
      ]),
    ]);
    expect(report).toMatchObject({ ok: true, created: 1, updated: 1, unchanged: 1 });
    expect(report.rows.map((r) => [r.name, r.status])).toEqual([
      ["A | B", "update"],
      ["B | C", "unchanged"],
      ["C | A", "create"],
    ]);
    expect((await links(dataset)).map((l) => l.weight).sort((x, y) => x - y)).toEqual([2, 3, 10]);
  });

  it("refuses two rows with one key, and a sheet without a column of the key", async () => {
    const { dataset } = await setup();
    await seedLinks(dataset);
    const report = await importSheets(dataset, [
      sheet("link", [
        { source: "C", target: "A", weight: 1 },
        { source: "C", target: "A", weight: 2 },
      ]),
      sheet("comment", [{ text: "x" }]),
    ]);
    expect(report.rows[1]).toMatchObject({ status: "refused", code: "duplicate_row" });
    expect(report.errors).toEqual([expect.objectContaining({ sheet: "comment", code: "missing_key" })]);
    expect(await links(dataset)).toHaveLength(2);
  });

  it("refers to an entity without a name by its label, and says what it cannot find", async () => {
    const { dataset } = await setup();
    await seedLinks(dataset);
    const report = await importSheets(dataset, [
      sheet("comment", [
        { about: "link: B | C", "text (fr)": "Cher" },
        { about: "link: C | C", "text (fr)": "?" },
        { about: "Z", "text (fr)": "?" },
      ]),
    ]);
    expect(report.rows.map((r) => [r.status, r.code])).toEqual([
      ["create", undefined],
      ["refused", "unresolved_reference"],
      ["refused", "unresolved_reference"],
    ]);
    expect(await all(dataset, "comment")).toHaveLength(0);
  });

  it("asks for the schema when a text could be a box or a link", async () => {
    const { dataset } = await setup();
    await seedLinks(dataset);
    await dataset.run("plants/create_box", { name: "B | C" }); // a box whose name is the label of a link
    const report = await importSheets(dataset, [sheet("comment", [{ about: "B | C", "text (fr)": "?" }])]);
    expect(report.rows[0]).toMatchObject({ status: "refused", code: "ambiguous_reference" });
    expect(report.rows[0].reason).toContain("box: B | C");
    expect(report.rows[0].reason).toContain("link: B | C");
    const fixed = await importSheets(dataset, [sheet("comment", [{ about: "link: B | C", "text (fr)": "ok" }])]);
    expect(fixed.ok).toBe(true);
  });

  it("writes an entity that refers to one created in the same import, whatever the order of the sheets", async () => {
    const { dataset } = await setup();
    const report = await importSheets(dataset, [
      sheet("comment", [{ about: "link: X | Y", "text (fr)": "Nouveau" }]),
      sheet("link", [{ source: "X", target: "Y", weight: 5 }]),
      sheet("box", [{ name: "X" }, { name: "Y" }]),
    ]);
    expect(report).toMatchObject({ ok: true, created: 4 });
    expect(report.order).toEqual(["box", "link", "comment"]);
    const [link] = await links(dataset);
    const [comment] = await all(dataset, "comment");
    expect(comment.about).toBe(link.id);
  });

  it("finds an entity with no group by all its values: an equal row is that entity", async () => {
    const { dataset } = await setup();
    await seedLinks(dataset);
    const rows = [{ about: "box: A", "text (fr)": "Début", "text (en)": "Start" }];
    expect((await importSheets(dataset, [sheet("comment", rows)])).created).toBe(1);
    const again = await importSheets(dataset, [sheet("comment", rows)]);
    expect(again).toMatchObject({ ok: true, created: 0, unchanged: 1 });
    expect(await all(dataset, "comment")).toHaveLength(1);
    // a row given twice is two comments, since nothing tells them apart
    const twice = await importSheets(dataset, [sheet("comment", [...rows, ...rows])]);
    expect(twice).toMatchObject({ ok: true, created: 1, unchanged: 1 });
    expect(await all(dataset, "comment")).toHaveLength(2);
    // another text is another comment
    expect((await importSheets(dataset, [sheet("comment", [{ about: "box: A", "text (fr)": "Fin" }])])).created).toBe(1);
  });

  it("round trips, into an empty dataset and into itself", async () => {
    const { dataset, fresh } = await setup();
    await seedLinks(dataset);
    const a = (await links(dataset)).find((l) => l.weight === 1)!;
    await dataset.run("plants/create_comment", { about: a.id, text: { fr: "Lent", en: "Slow" } });
    await dataset.run("plants/create_comment", { about: (await all(dataset, "box")).find((b) => b.name === "A")!.id, text: { fr: "Début" } });
    const exported = await exportSheets(dataset);
    const copy = await fresh();
    const report = await importSheets(copy, exported.sheets);
    expect(report).toMatchObject({ ok: true, refused: 0 });
    expect((await exportSheets(copy)).sheets).toEqual(exported.sheets);
    const again = await importSheets(dataset, exported.sheets);
    expect(again.rows.filter((r) => r.status !== "unchanged")).toEqual([]);
  });
});
