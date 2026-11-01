# Multilingual properties

A property can hold its text in several languages. A schema opts in by typing the
property `localized_string` or `localized_markdown`; every other property stays a
plain `string` or `markdown`, and a dataset that never uses these types is
unaffected. The types are maps keyed by language: see "Map types" in
[authoring.md](authoring.md) for the notation and its constraints.

## Declare

```ts
await runCommand(upgradeLocator, {
  create: "schema",
  input: [{
    name: "plant",
    shared_by_name: null,
    properties: [
      { name: "name", type: "identifier" },
      { name: "display_name", type: "localized_string", min_length: 1 },
      { name: "description", type: "localized_markdown" },
    ],
  }],
});
```

`min_length: 1` requires at least one language. A key is a `language_code`: two
lowercase letters, optionally followed by a region (`en`, `fr`, `pt-BR`).

## Create and read

```ts
await runCommand(locator, {
  create: "plant",
  input: [{ name: "oak", display_name: { en: "Oak", fr: "Chêne" } }],
});
```

The dataset holds every language, and a query returns the whole map. The engine has
no current language: the reader chooses the language to show and its fallback.

```ts
const label = (map: Record<string, string>, language: string, fallback = "en") =>
  map[language] ?? map[fallback] ?? Object.values(map)[0] ?? "";
```

A property that is not given is the empty map `{}`.

## Translate

An `update` edits one language and leaves the others as they are (see "Map
operations" in [commands.md](commands.md)):

```ts
{ update: "plant", filters: { name: "oak" }, input: { display_name: { set: { de: "Eiche" } } } }
{ update: "plant", filters: { name: "oak" }, input: { display_name: { remove: ["de"] } } }
```

A literal map replaces every language at once.

## Filter

A path reaches the entry of one language (see "Filters" in
[commands.md](commands.md)):

```ts
{ query: "plant", filters: { "display_name.fr": "Chêne" } }
{ query: "plant", filters: { not: { "display_name.fr": { exists: true } } } } // no French entry yet
```

An instance with no entry for the language satisfies no predicate on that path,
`ne` included.

## What the engine leaves out

The engine has no source language, no `default_value` for a localized property, and
no detection of a translation made stale by a change of the source (see
[limitations.md](limitations.md)). A persistent format stores a map as an ordinary
object; what a format does with a localized `display_name` is described in its own
README (see [formats.md](formats.md)).
