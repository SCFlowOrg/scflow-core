import { describe, expect, it } from "vitest";
import { CsvError, formatCsv, parseCsv, sheetFromCsv, sheetToCsv } from "../src/csv.js";

describe("formatCsv", () => {
  it("writes the records with a comma and a line break, a final one included", () => {
    expect(formatCsv([["a", "b"], ["1", "2"]], ",")).toBe("a,b\n1,2\n");
  });

  it("quotes a field that holds the separator, a quote or a line break, and doubles the quotes", () => {
    expect(formatCsv([["a,b", 'say "hi"', "two\nlines", "plain"]], ",")).toBe('"a,b","say ""hi""","two\nlines",plain\n');
    expect(formatCsv([["a\r\nb"]], ",")).toBe('"a\r\nb"\n');
  });

  it("quotes against the separator given, not against the comma", () => {
    expect(formatCsv([["a,b", "c;d"]], ";")).toBe('a,b;"c;d"\n');
  });
});

describe("parseCsv", () => {
  it("reads records, with or without a final line break, with LF or CRLF", () => {
    expect(parseCsv("a,b\n1,2\n", ",")).toEqual([["a", "b"], ["1", "2"]]);
    expect(parseCsv("a,b\r\n1,2", ",")).toEqual([["a", "b"], ["1", "2"]]);
  });

  it("reads quoted fields: separator, doubled quotes and line breaks are kept", () => {
    expect(parseCsv('"a,b","say ""hi""","two\nlines"\n', ",")).toEqual([["a,b", 'say "hi"', "two\nlines"]]);
    expect(parseCsv('"a\r\nb",c', ",")).toEqual([["a\r\nb", "c"]]);
  });

  it("keeps empty fields, also the last one", () => {
    expect(parseCsv("a,,c,\n", ",")).toEqual([["a", "", "c", ""]]);
  });

  it("reads another separator", () => {
    expect(parseCsv("a;b,c;d\n", ";")).toEqual([["a", "b,c", "d"]]);
    expect(parseCsv("a\tb\n", "\t")).toEqual([["a", "b"]]);
  });

  it("accepts a leading byte order mark", () => {
    expect(parseCsv("﻿name,code\nFrance,FR\n", ",")).toEqual([["name", "code"], ["France", "FR"]]);
  });

  it("keeps a blank line as a record, so that the lines are counted as the sheet counts them", () => {
    expect(parseCsv("a\n\nb\n", ",")).toEqual([["a"], [""], ["b"]]);
  });

  it("reads nothing from an empty text", () => {
    expect(parseCsv("", ",")).toEqual([]);
  });

  it("refuses a quote that never closes, and text after a closing quote", () => {
    expect(() => parseCsv('a,"b\n', ",")).toThrow(CsvError);
    expect(() => parseCsv('"a"b,c\n', ",")).toThrow(CsvError);
  });

  it("refuses a quote in the middle of an unquoted field", () => {
    expect(() => parseCsv('a"b,c\n', ",")).toThrow(CsvError);
  });
});

describe("sheetToCsv and sheetFromCsv", () => {
  const sheet = {
    name: "country",
    columns: ["name (fr)", "name (en)", "population", "active", "note"],
    rows: [
      { "name (fr)": "Allemagne", "name (en)": "Germany", population: 83.5, active: true, note: null },
      { "name (fr)": "France", "name (en)": "France", population: null, active: false, note: 'a "b", c' },
    ],
  };

  it("writes a header, empty cells for null, and numbers and booleans as text", () => {
    expect(sheetToCsv(sheet, ",")).toBe('name (fr),name (en),population,active,note\nAllemagne,Germany,83.5,true,\nFrance,France,,false,"a ""b"", c"\n');
  });

  it("keeps a header with a language as it is", () => {
    expect(parseCsv(sheetToCsv(sheet, ";"), ";")[0]).toEqual(["name (fr)", "name (en)", "population", "active", "note"]);
  });

  it("reads a sheet back: cells are text, an empty field is null", () => {
    const back = sheetFromCsv("country", sheetToCsv(sheet, ","), ",");
    expect(back.name).toBe("country");
    expect(back.columns).toEqual(sheet.columns);
    expect(back.rows).toEqual([
      { "name (fr)": "Allemagne", "name (en)": "Germany", population: "83.5", active: "true", note: null },
      { "name (fr)": "France", "name (en)": "France", population: null, active: "false", note: 'a "b", c' },
    ]);
  });

  it("gives the missing cells of a short record as empty, and refuses a value beyond the header", () => {
    expect(sheetFromCsv("s", "a,b,c\n1\n", ",").rows).toEqual([{ a: "1", b: null, c: null }]);
    expect(() => sheetFromCsv("s", "a,b\n1,2,3\n", ",")).toThrow(/line 2/);
    expect(sheetFromCsv("s", "a,b\n1,2,\n", ",").rows).toEqual([{ a: "1", b: "2" }]);
  });

  it("refuses a file with no header", () => {
    expect(() => sheetFromCsv("s", "", ",")).toThrow(CsvError);
  });
});
