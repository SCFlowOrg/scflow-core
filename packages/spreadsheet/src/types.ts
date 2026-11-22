import type { AuthoredCommand, CommandResult } from "@scfloworg/core";

/** The value of a cell: what a spreadsheet holds. An empty cell is `null`. */
export type CellValue = string | number | boolean | null;

/** One row of a sheet: the cells by column header. A header the row does not hold is an empty cell. */
export type Row = Record<string, CellValue>;

/**
 * A sheet: the rows of one entity type. The header of a column is the name of
 * a property of the schema (`name`, `type`), with the language in parentheses
 * for a localized property (`name (fr)`) and the qualified name of a property
 * a facet adds (`carbon.co2`). A reference to another entity is written as its
 * name, as short as it stays unambiguous, never as an id.
 */
export interface Sheet {
  /**
   * The title of the sheet: the short name of the schema, `actor`, or its
   * qualified name, `scflow.actor`, when two schemas share the short name.
   * An import reads the schema from `schema` when it is given, else from `name`.
   */
  name: string;
  /** The qualified name of the schema the rows belong to. */
  schema?: string;
  /** The headers of the columns, in order. An import accepts them in any order. */
  columns: string[];
  rows: Row[];
}

/**
 * What the package needs of a dataset: the subset of `OpenDataset` of
 * `@scfloworg/environment` it reads and writes through. Anything with these
 * members works, so this package depends on no environment.
 */
export interface SpreadsheetDataset {
  /** Reads: a `query` command on the dataset. */
  query(command: AuthoredCommand): Promise<CommandResult>;
  /** Runs an action in the open transaction. A failed action rolls the transaction back. */
  run(id: string, params?: unknown): Promise<{ readonly result: unknown }>;
  /** The actions the dataset can run, with their parameters as a JSON Schema or its text. */
  actions(): readonly { readonly id: string; readonly kind?: string; readonly parameters?: unknown }[];
  /** The dataset record: its `languages`. */
  info(): Promise<unknown>;
  /** The dump, which embeds the manifest of each module: the model comes from it. */
  dump(format: "json"): Promise<string>;
  begin(label?: string): Promise<void>;
  prepare(): Promise<unknown>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export interface ExportOptions {
  /** The separator of the values of a list in a cell. Default `;`. */
  listSeparator?: string;
  /** Only these schemas, by qualified or short name. Default: every schema with a `name_scope`. */
  schemas?: readonly string[];
}

/** Something an export leaves out, with the reason, so that nothing disappears in silence. */
export interface Skipped {
  /** The qualified name of the schema. */
  schema: string;
  /** The property, absent when the whole schema is left out. */
  property?: string;
  reason: string;
}

export interface ExportResult {
  sheets: Sheet[];
  /** The languages of the dataset, the first being the source language. */
  languages: string[];
  skipped: Skipped[];
}

export interface ImportOptions {
  /** The separator of the values of a list in a cell. Default `;`. */
  listSeparator?: string;
  /**
   * Checks everything, runs the writes in a transaction and rolls it back: the
   * report says what would be created, updated or refused, rules included.
   */
  dryRun?: boolean;
  /** The label of the transaction, shown in an undo history. */
  label?: string;
  /**
   * `own`, the default: the import opens, prepares and commits the transaction,
   * which is one undo step. `caller`: the caller opened a transaction and ends
   * it; the import only runs its actions in it. A dry run needs `own`.
   */
  transaction?: "own" | "caller";
}

/** What an import does to a row. `refused` rows refuse the whole import. */
export type RowStatus = "create" | "update" | "unchanged" | "refused" | "not_run";

export interface RowReport {
  /** The title of the sheet. */
  sheet: string;
  /** The line of the row in the sheet, the header being line 1. */
  line: number;
  /** The reference of the entity, qualified, in the source language; the name written in the row when it has none yet. */
  name: string;
  status: RowStatus;
  /** The properties that change, for an update. */
  changes?: string[];
  /** Why the row is refused. */
  reason?: string;
  /** The code of the first reason, see `ImportCode`. */
  code?: string;
}

/** A refusal about a whole sheet, or about the import, not about one row. */
export interface ImportError {
  sheet?: string;
  code: string;
  message: string;
}

export interface ImportReport {
  /** `true` when no row is refused and there is no error. */
  ok: boolean;
  dryRun: boolean;
  /** `true` when the writes are committed; `false` for a dry run and for a refused import. */
  applied: boolean;
  created: number;
  updated: number;
  unchanged: number;
  refused: number;
  /** Every row of every sheet, in the order of the sheets given. */
  rows: RowReport[];
  errors: ImportError[];
  /** The sheets in the order their rows are written, which the mandatory relations decide. */
  order: string[];
  /** The delta of the committed transaction: apply its inverse in a transaction to undo the whole import. */
  delta?: unknown;
}

/** The codes of the reasons an import gives, beside the codes of the engine (`unresolved_reference`, `ambiguous_reference`, `rule_violation`...). */
export type ImportCode =
  | "unknown_sheet"
  | "unknown_column"
  | "duplicate_column"
  | "missing_name"
  | "invalid_value"
  | "missing_required"
  | "not_writable"
  | "no_action"
  | "duplicate_row"
  | "dependency_cycle";

/** The error the package throws for a call it cannot serve, with a `code`. */
export class SpreadsheetError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SpreadsheetError";
  }
}
