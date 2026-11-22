/**
 * CSV as the sheets of `@scfloworg/spreadsheet` need it (RFC 4180, with a
 * chosen separator): a reader and a writer of records of text, and the
 * conversion of one sheet to and from a file. Cells are text; the import turns
 * them into the type of their property.
 */

import type { CellValue, Row, Sheet } from "@scfloworg/spreadsheet";

/** A text that is not CSV. Its `code` is `invalid_csv`, as in every refusal of `scflow`. */
export class CsvError extends Error {
  readonly code = "invalid_csv";
  constructor(message: string) {
    super(message);
    this.name = "CsvError";
  }
}

const BYTE_ORDER_MARK = 0xfeff;

const isLineBreak = (c: string | undefined): boolean => c === "\n" || c === "\r";

/**
 * Reads the records of a CSV text. A leading byte order mark is dropped; a
 * record ends with LF, CRLF or CR, or with the end of the text; a quoted field
 * keeps its separators and line breaks, and `""` is a quote. A blank line is a
 * record of one empty field, so that a record keeps the number it has in the
 * file.
 *
 * @throws `CsvError` for a quote that never closes, text after a closing
 * quote, or a quote inside a field that does not start with one.
 */
export function parseCsv(text: string, separator: string): string[][] {
  if (text.charCodeAt(0) === BYTE_ORDER_MARK) text = text.slice(1);
  const records: string[][] = [];
  let record: string[] = [];
  let line = 1;
  let i = 0;
  while (i < text.length) {
    let field = "";
    if (text[i] === '"') {
      i += 1;
      for (;;) {
        if (i >= text.length) throw new CsvError(`line ${line}: a quoted field is never closed`);
        const c = text[i] as string;
        if (c === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        if (c === "\n") line += 1;
        field += c;
        i += 1;
      }
      if (i < text.length && text[i] !== separator && !isLineBreak(text[i])) throw new CsvError(`line ${line}: text follows a closing quote`);
    } else {
      while (i < text.length && text[i] !== separator && !isLineBreak(text[i])) {
        if (text[i] === '"') throw new CsvError(`line ${line}: a quote inside a field that is not quoted`);
        field += text[i];
        i += 1;
      }
    }
    record.push(field);
    if (i >= text.length) break;
    if (text[i] === separator) {
      i += 1;
      if (i >= text.length) record.push("");
      continue;
    }
    i += text[i] === "\r" && text[i + 1] === "\n" ? 2 : 1;
    line += 1;
    records.push(record);
    record = [];
  }
  if (record.length > 0) records.push(record);
  return records;
}

function quoted(field: string, separator: string): string {
  const needsQuotes = field.includes(separator) || field.includes('"') || field.includes("\n") || field.includes("\r");
  return needsQuotes ? `"${field.replaceAll('"', '""')}"` : field;
}

/** Writes records, each ended by a line break. A field with the separator, a quote or a line break is quoted, the quotes doubled. */
export function formatCsv(records: readonly (readonly string[])[], separator: string): string {
  return records.map((record) => `${record.map((field) => quoted(field, separator)).join(separator)}\n`).join("");
}

const textOf = (cell: CellValue | undefined): string => (cell === null || cell === undefined ? "" : String(cell));

/** The CSV of a sheet: its header, then one record per row; an empty cell is an empty field, a number or a boolean its text. */
export function sheetToCsv(sheet: Pick<Sheet, "columns" | "rows">, separator: string): string {
  return formatCsv([sheet.columns, ...sheet.rows.map((row) => sheet.columns.map((column) => textOf(row[column])))], separator);
}

/**
 * The sheet a CSV text holds, named `name`. The first record is the header;
 * an empty field is an empty cell (`null`), any other is its text. A record
 * shorter than the header leaves its last cells empty, and a record with more
 * cells than the header is refused, unless the extra cells are empty.
 *
 * @throws `CsvError` for a text that is not CSV, a text with no header, or a record wider than the header.
 */
export function sheetFromCsv(name: string, text: string, separator: string): Sheet {
  const [columns, ...records] = parseCsv(text, separator);
  if (columns === undefined) throw new CsvError(`${name}: the file is empty, it needs a header line`);
  const rows = records.map((record, index): Row => {
    const extra = record.slice(columns.length).some((cell) => cell !== "");
    if (extra) throw new CsvError(`${name}: line ${index + 2} has ${record.length} cells, the header has ${columns.length}`);
    return Object.fromEntries(columns.map((column, at) => [column, record[at] === undefined || record[at] === "" ? null : record[at]]));
  });
  return { name, columns, rows };
}
