/**
 * `scflow export` and `scflow import`: a project as CSV files, one per sheet of
 * `@scfloworg/spreadsheet` (see `docs/scflow.md`). The sheets know nothing of
 * files; the files and the document are here.
 */

import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { exportSheets, importSheets, type ImportReport, type Sheet, type Skipped, type SpreadsheetDataset } from "@scfloworg/spreadsheet";
import type { Document } from "@scfloworg/workspace";
import { sheetFromCsv, sheetToCsv } from "./csv.js";

/** The label of the undo step of an import. */
export const IMPORT_LABEL = "Import sheets";

/** The extension of the files, which name their sheet. */
export const CSV_EXTENSION = ".csv";

/** A refusal of the files: its `code` is the one printed. */
export class SheetFileError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SheetFileError";
  }
}

/** The separators of the columns and of the values of a list. */
export interface CsvOptions {
  separator: string;
  /** The separator of the values of a list in a cell; the one of the sheets (`;`) when left out. */
  listSeparator?: string | undefined;
}

export interface ExportOptions extends CsvOptions {
  /** The sheets to keep, by name; every sheet when empty. */
  schemas: readonly string[];
}

export interface ImportOptions extends CsvOptions {
  dryRun: boolean;
}

/**
 * The dataset `@scfloworg/spreadsheet` works on: the reads of the document's
 * dataset, and the writes and the transaction of the document itself, so that
 * the import is one transaction of the document and one undo step. Nothing
 * below the document is reached.
 */
export function documentDataset(doc: Document): SpreadsheetDataset {
  return {
    query: (command) => doc.dataset.query(command),
    run: (id, params) => doc.run(id, params),
    actions: () => doc.dataset.actions(),
    info: () => doc.dataset.info(),
    dump: (format) => doc.dataset.dump(format),
    begin: (label) => doc.begin(label ?? IMPORT_LABEL),
    prepare: () => doc.prepare(),
    commit: () => doc.commit(),
    rollback: () => doc.rollback(),
  };
}

/** The file of a sheet, named after it. */
const fileOf = (sheet: Sheet): string => `${sheet.name}${CSV_EXTENSION}`;

/** Writes the sheets of the document, one CSV file each, in `folder`, which is created if need be. Reads only. */
export async function exportCsv(doc: Document, folder: string, options: ExportOptions): Promise<{ files: string[]; skipped: Skipped[] }> {
  const { sheets, skipped } = await exportSheets(documentDataset(doc), {
    ...(options.schemas.length > 0 ? { schemas: options.schemas } : {}),
    ...(options.listSeparator === undefined ? {} : { listSeparator: options.listSeparator }),
  });
  await mkdir(folder, { recursive: true });
  for (const sheet of sheets) await writeFile(join(folder, fileOf(sheet)), sheetToCsv(sheet, options.separator), "utf8");
  return { files: sheets.map(fileOf), skipped };
}

/** The `.csv` files an input stands for: the file itself, or those of a folder, by name. */
async function filesOfInput(input: string): Promise<string[]> {
  let info;
  try {
    info = await stat(input);
  } catch (error) {
    throw new SheetFileError("file_unreadable", `cannot read ${input}: ${(error as Error).message}`);
  }
  if (!info.isDirectory()) return [input];
  const names = (await readdir(input)).filter((name) => extname(name).toLowerCase() === CSV_EXTENSION).sort();
  return names.map((name) => join(input, name));
}

/** The files named by the inputs, in order, or `undefined` when a folder holds no `.csv` file. */
export async function csvFilesOf(inputs: readonly string[]): Promise<string[] | undefined> {
  const files: string[] = [];
  for (const input of inputs) {
    const found = await filesOfInput(input);
    if (found.length === 0) return undefined;
    files.push(...found);
  }
  return files;
}

/** Reads the files as sheets, each named after its file. */
export async function readSheets(files: readonly string[], separator: string): Promise<Sheet[]> {
  const sheets: Sheet[] = [];
  for (const file of files) {
    const name = basename(file, extname(file));
    if (sheets.some((sheet) => sheet.name === name)) throw new SheetFileError("duplicate_sheet", `two files stand for the sheet "${name}"`);
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      throw new SheetFileError("file_unreadable", `cannot read ${file}: ${(error as Error).message}`);
    }
    sheets.push(sheetFromCsv(name, text, separator));
  }
  return sheets;
}

/**
 * Imports the files in one transaction of the document. The document is not
 * saved: the caller decides. A sheet that no schema has is a refusal of the
 * command, not a report.
 */
export async function importCsv(doc: Document, files: readonly string[], options: ImportOptions): Promise<ImportReport> {
  const sheets = await readSheets(files, options.separator);
  const report = await importSheets(documentDataset(doc), sheets, {
    label: IMPORT_LABEL,
    dryRun: options.dryRun,
    ...(options.listSeparator === undefined ? {} : { listSeparator: options.listSeparator }),
  });
  const unknown = report.errors.find((error) => error.code === "unknown_sheet");
  if (unknown) throw new SheetFileError(unknown.code, unknown.message);
  return report;
}
