# @scfloworg/spreadsheet

Converts an MCL dataset to rows of sheets, and rows of sheets to writes on the dataset. It is the neutral core of an import and export to a spreadsheet: it reads and writes no file (no CSV, no XLSX), draws no screen and knows no module. A command line, an MCP server, an AI or an application adds the file format on top of it.

See [docs/spreadsheet.md](docs/spreadsheet.md) for the rules of the sheets and the API.

```ts
import { exportSheets, importSheets } from "@scfloworg/spreadsheet";

// `dataset` is an OpenDataset of @scfloworg/environment, or anything with the same members
const { sheets } = await exportSheets(dataset); // one sheet per entity type, one row per entity
// sheets[0] = { name: "city", columns: ["name", "country", "population"], rows: [{ name: "Lyon", country: "France", population: 520000 }] }

const dry = await importSheets(dataset, sheets, { dryRun: true }); // what would be created, updated or refused
const report = await importSheets(dataset, sheets); // one transaction, one undo
```

- **Names, never ids.** A relation is written as the name of its target, as short as it stays unambiguous (`Paris`, or `France / Lyon` when two cities share a name). An id is accepted when read, never written.
- **Generic.** Every sheet comes from the schemas of the installed modules: the columns, the references, the localized texts (one column per language), the facets. Nothing is specific to a module.
- **Through the actions.** An import writes with the `create_*` and `update_*` actions of the model, so its rules and its integrity apply, as for any other caller.
- **All or nothing.** A refused row refuses the whole import, and the report gives every row with its reason. An import never deletes.

The only dependency is `@scfloworg/core`; the dataset is passed in, so the package does not depend on the environment either.
