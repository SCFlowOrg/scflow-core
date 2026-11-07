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

registerPersistentFormat(jsFormat);              // once, before any locator is used; createEngine gives formats of its own

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

## Rules that cost the most

Each rule is stated in the file named in brackets; read it before relying on the rule.

- A schema or a scalar type changes only through an upgrade locator; a schema command against any other locator fails with `not_upgrade_locator` ([model-upgrade.md](model-upgrade.md)).
- A filter value that is an array is refused on a property that is not an array; write `{ in: [...] }` ([commands.md](commands.md), Filters).
- An `update` or a `delete` without `filters` acts on every instance of the schema ([commands.md](commands.md)).
- A script that fails stops and does not roll back the commands it ran; wrap it in a transaction to make it atomic ([commands.md](commands.md), Scripts; [sessions.md](sessions.md)).
- A key of a `create` or `update` input that is not a property of the schema is dropped, not refused ([limitations.md](limitations.md)).

## Topics

- [spec/](spec/README.md): the normative specification of the meta-model and of MCL.

- [formats.md](formats.md): locators, persistent formats, engines with formats of their own, the `js` format.
- [datasets.md](datasets.md): datasets, the `dataset` instance, lifecycle, the built-in dataset, the modules of a dataset, local modules, imports.
- [modules.md](modules.md): module manifests, module sets, namespaces, short and qualified names, facets, `mcl:core`.
- [model-upgrade.md](model-upgrade.md): changing a model through an upgrade locator.
- [sessions.md](sessions.md): `MclAccess`, `ApiSession`, transactions, revert.
- [actions.md](actions.md): `ModelActionDefinition`, the actions a domain package exposes to UIs and AI assistants.
- [commands.md](commands.md): commands, text and map operations, filters, scripts, examples.
- [authoring.md](authoring.md): schemas, properties, map types, relations, extensions, placeholders, `ui_access`.
- [rules.md](rules.md): declared rules, `checks`, `unique`, `acyclic`, `set_once`, and when the engine checks them.
- [multilingual.md](multilingual.md): `localized_string` and `localized_markdown`, translating one language, filtering on one.
- [observability.md](observability.md): `observable` constraints and `subscribeObservable`.
- [limitations.md](limitations.md): what the engine does not do.

Every failure is a `ModelError`; the code of each cause and the condition that
raises it are documented on `ErrorCode`. The contract of each exported symbol is
its doc comment.
