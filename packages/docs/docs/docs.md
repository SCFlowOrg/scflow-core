# Documentation topics

`@scfloworg/docs` is the neutral package behind SCFlow documentation
([ADR-0014](https://github.com/SCFlowOrg/scflow-hub)). It knows no MCL, module,
plugin or user interface: a **source** gives topics, the **catalogue** merges
them, and readers (a help panel, a public site, an AI) ask the catalogue.

## Topic

One Markdown file with front matter, self-contained so a retrieved chunk makes
sense alone:

```yaml
id: scflow/undo               # namespace of the owner / name, stable, never reused
title: Undo and redo
summary: One or two sentences; also the search text.
kind: how-to                  # tutorial | how-to | reference | explanation
audience: user                # user | plugin-dev | model-dev
locale: en                    # default en; one file per locale
context: [documents.history]  # help keys opening this topic from an interface
uses: [scflow/undo]           # opaque to the package, checked by the source
generated: false              # true for reference built from declarations
```

`parseTopic(text)` reads and validates a file; `validateTopic(object)` checks a
topic held as data. The front matter is a small YAML subset (`key: value`,
`[a, b]`, block lists, `#` comments); anything else fails with `invalid_topic`.
A topic id is `namespace/name`, the name possibly with more `/` segments.

Links between topics use ids, `[[scflow/undo]]` or `[[scflow/undo|label]]`,
never paths. `topicLinks(body)` lists them, ignoring code.

## Source

```ts
interface DocsSource {
  id: string;
  list(): Promise<Topic[]>;                            // one entry per topic and locale
  read(topicId: string, locale?: string): Promise<string>; // body, no front matter
}
```

`createMemorySource(id, files)` builds one from strings, for a fixture or a
host that has read its files.

## Catalogue

```ts
const catalogue = await createCatalogue([moduleSource, frameworkSource]);
catalogue.topics({ audience: "user", locale: "fr" }); // one per id, ordered by id
catalogue.get("scflow/undo", "fr");
catalogue.resolveHelpKey("documents.history", { audience: "user" }); // the key may sit on any locale of the topic
await catalogue.read("scflow/undo");                  // body
await catalogue.search("redo a change", { audience: ["user"], limit: 5 });
await catalogue.check({ helpKeys });                  // DocsProblem[]
await catalogue.refresh();                            // list the sources again
```

- **Audience** is a filter the caller gives (`user`, `plugin-dev`, `model-dev`,
  one or a list). The package never decides it.
- **Locale** falls back to the default locale (`en`), then to any locale the
  topic has.
- **Duplicates**: one id and locale from two sources keeps the first source's
  topic; `check` reports the other.
- **Search** is keyword search: a topic scores for each term in its title (5),
  summary (3) and body (up to 5), plus a bonus when it holds every term.
- **`check`** reports `duplicate_id`, `unresolved_link` (a `[[id]]` no source
  gives), `ambiguous_help_key` (a key in the `context` of two topics),
  `unresolved_help_key` (a key in `options.helpKeys` that opens nothing) and
  `unreadable_topic`. An empty list means the catalogue is sound.

## Manifest

`buildManifest(catalogue.all(), sourceId)` and `serializeManifest` write
`docs-manifest.json` (`DOCS_MANIFEST_FILE`): the metadata of the topics, never
their bodies. `parseManifest` reads and validates it.

## Read tool

`createDocsTool(catalogue, { audience, locale, limit })` returns the definition
and the call of the tool `read_docs` (`DOCS_TOOL`), or `null` when the reader
has no topic. A host hands it to an AI like any other tool; the package defines
only the name, schema and result.

- `{ query }` returns `{ results: [{ id, title, summary, kind, audience, snippet }] }`.
- `{ topicId }` returns `{ topic, content }`, the Markdown body.
- Both fail with `invalid_parameters` unless exactly one is given, and a topic
  outside the audience is `not_found`.

## Errors

`DocsError` carries a `code`: `invalid_topic`, `not_found`, `invalid_parameters`.
