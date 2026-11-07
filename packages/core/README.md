# @scfloworg/core

The Model Command Language engine: schema processing, command and script
processing, filters, placeholders and the TypeScript API. It implements the
[Model specification](docs/spec/README.md) and works only against the
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

`createEngine({ formats })` gives the same functions bound to formats of their
own, with no global registration: two engines share nothing (see
[`docs/formats.md`](docs/formats.md), Engines).

## Documentation

- [`docs/spec/`](docs/spec/README.md) is the normative specification of the
  meta-model and of MCL. The code follows it.
- [`docs/mcl.md`](docs/mcl.md) introduces the language and indexes the usage
  documents: formats, datasets with their modules and imports, modules and their facets, model upgrade, sessions, commands, authoring,
  multilingual properties, observability, model actions and limitations.
- The contract of each exported symbol, its errors included, is its doc comment.
  `ErrorCode` documents every error code.
