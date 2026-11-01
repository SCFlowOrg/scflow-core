# Using MCL with `@scfloworg/core`

MCL, the Model Command Language, reads and edits datasets: it queries, creates,
updates and deletes instances of schemas, and it describes those schemas itself.
`@scfloworg/core` is the engine. It works on datasets reached by **locator** and
stores them through a **persistent format** that the host registers.

```ts
import {
  registerPersistentFormat, initDataset, createUpgradeLocator, upgradeDataset,
  runCommand, runScript,
} from "@scfloworg/core";
import { jsFormat } from "@scfloworg/format-js/browser"; // in-memory format

registerPersistentFormat(jsFormat);              // once, before any locator is used

await initDataset("js:app", "builtin");          // built-in dataset of the area "app"
await initDataset("js:app/doc1", "doc1");        // a dataset of that area

// A schema is created through an upgrade locator, never on the dataset itself.
const upgrade = await createUpgradeLocator("js:app");
await runCommand(upgrade, { kind: "create", schema: "schema", input: [
  { name: "task", is_root: true, properties: [
    { name: "title", type: "string" },
    { name: "priority", type: "integer", default_value: 0 },
  ] },
] });
await upgradeDataset("js:app", upgrade);         // every dataset of "app" now sees `task`

await runCommand("js:app/doc1", { kind: "create", schema: "task", input: { title: "Ship" } });
const { after } = await runCommand("js:app/doc1", { kind: "query", schema: "task" });
```

## Topics

- [formats.md](formats.md): locators, persistent formats, the `js` format.
- [datasets.md](datasets.md): datasets, the `dataset` instance, lifecycle, the built-in dataset.
- [model-upgrade.md](model-upgrade.md): changing a model through an upgrade locator.
- [sessions.md](sessions.md): `MclAccess`, `ApiSession`, transactions, revert.
- [actions.md](actions.md): `ModelActionDefinition`, the actions a domain package exposes to UIs and AI assistants.
- [commands.md](commands.md): commands, text and map operations, filters, scripts, examples.
- [authoring.md](authoring.md): schemas, properties, map types, relations, extensions, placeholders, `ui_access`.
- [multilingual.md](multilingual.md): `localized_string` and `localized_markdown`, translating one language, filtering on one.
- [observability.md](observability.md): `observable` constraints and `subscribeObservable`.
- [limitations.md](limitations.md): what the engine does not do.

Every failure is a `ModelError`; the code of each cause and the condition that
raises it are documented on `ErrorCode`. The contract of each exported symbol is
its doc comment.
