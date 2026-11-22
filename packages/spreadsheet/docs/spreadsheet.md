# Sheets: the rules

A **sheet** is the rows of one entity type: `{ name, schema?, columns, rows }`. A **row** is an object of cells by column header; a cell is a string, a number, a boolean or `null` (empty). The package reads and writes rows only. Turning them into a CSV or an XLSX file is the job of a layer above.

```ts
interface Sheet {
  name: string; // the short name of the schema, `actor`; qualified, `scflow.actor`, when two schemas share it
  schema?: string; // the qualified name of the schema; an import reads it from `name` when absent
  columns: string[];
  rows: Record<string, string | number | boolean | null>[];
}
```

## Which entities have a sheet

Every entity type that is stored has a sheet: the whole content of a dataset can be exported and read back. A schema that is abstract, embedded, a facet or a singleton has none.

A row must be found again among the instances, and other rows must be able to refer to it. What does that depends on the schema, in this order:

1. **It has a `name_scope`** (see [References by name](../../core/docs/references.md)): the key is its **name in its scope**, and a reference to it is its name, as short as it stays unambiguous.
2. **It has no name but declares a `unique` group**: the key is the values of the first group (a flow: its source, destination, item and route). A reference to it is its **label**, the values of the group joined by ` | `, each relation written as a reference: `Plant | Depot | Bolt`.
3. **It has neither** (a note): the key is the values of all its properties, and its label is the same. A row equal to an instance is that instance. A row given twice means two instances: each row takes the next equal instance that no row took yet, and creates one when none is left.

When a relation can point at several schemas (the `annotated` of a note can point at an actor, a flow, an item...), the reference starts with the schema: `actor: Lyon`, `flow: Lyon | Paris | Bolt`. On import, the prefix can be left out when the text designates only one entity; an ambiguity lists the candidates with their prefix.

## The columns

The columns are the properties of the schema, in its order, `name` first.

| Property | Column | Cell |
| --- | --- | --- |
| a `string`, `number`, `integer`, `boolean` | the property name | the value |
| a list of scalars (`is_array`) | the property name | the values in one cell, joined by the separator (default `;`) |
| a relation | the property name | the reference of the target: its name, as short as it stays unambiguous, `Paris`, or `France / Lyon` |
| a localized property (`localized_string`, `localized_markdown`) | `name (fr)`, `name (en)`: one per language of the dataset, the first being the source language | the text of that language |
| a property a facet adds | its qualified name, `carbon.co2`, `carbon.label (fr)` | as above |

Left out, and listed in `skipped` with a reason: an owned embedded schema, a map that is not a text by language. A generated inverse relation is never a column.

**No id is ever written.** A reference is the shortest suffix of the qualified name that designates one entity. The qualified name is the chain of the scopes, `France / Lyon / Line 1`; the spaces around `/` do not matter. The reference is written in the source language of the dataset. If a value of a list contains the separator, the export fails with `separator_in_value`: choose another separator.

Rows are sorted by qualified name, so two exports of the same dataset are the same.

## The import

An import reads every row and checks it before writing anything.

1. **Sheets and columns.** A sheet is found by its `schema`, else by its `name`, qualified or short. A column is a header of the layout above; a bare header of a localized property (`name`) means the source language. An unknown, repeated or missing `name` column is an error of the sheet. A line with only empty cells is ignored.
2. **Which entity.** The key of a row is its **name, in its scope**. The scope is given by the relations of `name_scope` (`city` for a line, `parent_actor` or `scope` for an actor). An existing name in that scope is an update; a new name is a creation. A localized name matches on any of its languages, exactly and case-sensitively. When the scope cells are empty, the name is looked up in every scope, and several matches are refused: give the scope. Two rows for one entity are refused (`duplicate_row`). A row of a schema with no name is found by the values of its `unique` group, or of all its properties (see above), and the sheet must have a column for each of them (`missing_key`). The same key as an existing entity is an update, a new key a creation.
3. **References.** Each relation cell is resolved as the engine does ([References by name](../../core/docs/references.md)): an id first, then a suffix of a qualified name, in any language, then a label. No match is `unresolved_reference`; several are `ambiguous_reference`, and the reason lists the candidates so that the cell can be corrected. A reference may name an entity another row creates, whatever the kind of entity.
4. **Values.** A cell is converted to the type of its property, then checked against the signature of the action that will write it: its type, its enumeration, its pattern, the parameters it requires. A cell that the action cannot write (a computed property) is refused when it would change something, and ignored when it holds what the entity already has.
5. **Create or update.** A create writes the cells that are not empty, so the defaults of the model apply. An update writes only what changes: an empty cell clears the property, an absent column leaves it alone, and a value equal to the stored one is not written, so a row that changes nothing is `unchanged`. The name is the exception: it identifies the entity, so an empty language cell of a name never removes that language. A mandatory property cannot be emptied.
6. **Order.** Rows are written after the rows they need: a city after its country, whichever order the sheets come in, and a row after the row of its own sheet it refers to. An optional relation that closes a cycle is written after the creations, in an update. A cycle of mandatory relations, or of the scope, cannot be written: the rows of the cycle are refused (`dependency_cycle`).
7. **Writes.** An entity that another row creates is given to its action by the id its create action returned. The rows are written by the actions of the model: the action `crud` names for the schema, else `<namespace>/create_<schema>` and `<namespace>/update_<schema>`; the values of a facet by the update action of the facet. A model that offers none for a row refuses it (`no_action`). The rules of the model are checked at the end of the transaction, and a row that breaks one is refused with `rule_violation`.

An import **never deletes**: an entity that is not in a sheet is left as it is.

### All or nothing

The whole import is one transaction: one undo takes it back (`report.delta` is the delta to revert). If any row is refused, or the transaction is refused at its end, nothing is written, and the report lists every row.

```ts
interface ImportReport {
  ok: boolean; // no refused row, no error
  dryRun: boolean;
  applied: boolean; // the writes are committed
  created: number;
  updated: number;
  unchanged: number;
  refused: number;
  rows: { sheet; line; name; status; changes?; reason?; code? }[]; // status: create | update | unchanged | refused | not_run
  errors: { sheet?; code; message }[]; // a sheet, or the import itself
  order: string[]; // the sheets in the order their rows are written
  delta?: unknown;
}
```

`line` is the line of the row in the sheet, the header being line 1. A row that is fine keeps its status (`create`, `update`) when another row refuses the import, with `applied: false`. A row after the first failed write is `not_run`.

### Dry run

`dryRun: true` runs the whole import, writes included, then rolls the transaction back. The report says what would be created, updated or refused, and the rules of the model are checked too, since they run at the end of the transaction.

### The transaction

By default the import opens, prepares and commits its transaction (`transaction: "own"`). A caller that has opened one (`dataset.begin`) passes `transaction: "caller"`: the import runs its actions in it and leaves the end, and the check of the rules, to the caller. A dry run needs `own`.

## The dataset

The package does not depend on the environment. It takes any object with `query`, `run`, `actions`, `info`, `dump`, `begin`, `prepare`, `commit` and `rollback`: an `OpenDataset` of `@scfloworg/environment` is one. The model comes from the manifests of the modules the dump embeds, built by `buildDatasetModel` of `@scfloworg/core`; `loadContext(dataset)` returns it with the languages of the dataset.

## Codes

Beside the codes of the engine (`unresolved_reference`, `ambiguous_reference`, `rule_violation`...), the reasons of an import use: `unknown_sheet`, `unknown_column`, `duplicate_column`, `missing_name`, `invalid_value`, `missing_required`, `not_writable`, `no_action`, `duplicate_row`, `dependency_cycle`. The package throws `SpreadsheetError` (with a `code`) for a call it cannot serve: an export that names an unknown sheet, a value that contains the list separator, a dry run in a transaction of the caller.

## Limits

- An entity found by all its values (no `name_scope`, no `unique` group) cannot be changed by an import: a different value is a different entity. Declare a `unique` group on the schema to get updates.
- The label of an entity is computed from the references of its parts: if the dataset gains a duplicate name, the label of what refers to it changes, and an old file fails with the candidates instead of guessing.
- A scope that an import changes in the same run is not followed: a reference is resolved against the names the import gives.
