# @scfloworg/core

The Model Command Language engine: schema processing, command and script
processing, filters, placeholders and the TypeScript API. It implements the Model
convention (document `model` of the `core` dataset) and works only against the
`PersistenceInterface` contract, never against a specific storage format. Any
format that implements it, `@scfloworg/format-js` today, gets the full command
language, and can prove it with `@scfloworg/conformance`. The package does no I/O
of its own and runs in Node and in a browser.

## Start

Install `@scfloworg/core` and a persistent format such as `@scfloworg/format-js`,
register the format once, then reach datasets by locator.

```ts
import { registerPersistentFormat, initDataset, queryDataset } from "@scfloworg/core";
import { jsFormat } from "@scfloworg/format-js";

registerPersistentFormat(jsFormat);
await initDataset("js:app", "app");
const dataset = await queryDataset("js:app"); // the dataset's name, versions and schemas
```

## Documentation

- [`docs/mcl.md`](docs/mcl.md) introduces the language and indexes the usage
  documents: formats, datasets, model upgrade, sessions, commands, authoring,
  multilingual properties, observability, model actions and limitations.
- The contract of each exported symbol, its errors included, is its doc comment.
  `ErrorCode` documents every error code.
