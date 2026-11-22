# References by name

An instance is keyed by an id that no person needs to see. People designate it by
its **name**, as short as it stays unambiguous. A schema opts in with
`name_scope`; the normative text is
[Names and References](spec/meta-model.md#names-and-references) in the
specification. This guide shows how to use it.

## Declare

```ts
await runCommand(upgradeLocator, {
  create: "schema",
  input: [
    { name: "country", name_scope: [], properties: [{ name: "name", type: "localized_string" }] },
    { name: "city", name_scope: ["country"], properties: [
      { name: "name", type: "string" },
      { name: "country", type: "country", mandatory: true },
    ] },
    { name: "line", name_scope: ["city"], properties: [
      { name: "name", type: "string" },
      { name: "city", type: "city", mandatory: true },
    ] },
  ],
});
```

- `name_scope: []` says the name is unique in the dataset.
- `name_scope: [city]` says the name is unique among the instances of the same
  `city`: the scope of a `line` is its city.
- The schema declares a `name` of type `string` or `localized_string`. It is
  mandatory, not empty, and cannot contain `/`.
- `shared_by_name` is reserved to the meta-model and refused on these schemas.
- A schema extending one with `name_scope` inherits it and cannot change it.

## The same name in two parents

```text
France / Lyon / Line 1
France / Paris / Line 1
France / Paris / Assembly
```

Two lines are called `Line 1`: they have different scopes. A second `Line 1` in
Lyon is refused when the transaction ends, with a `rule_violation` named
`name_scope` that gives the schema, the instance and the scope. Names are compared
in every language, exactly and case-sensitively, after trimming spaces, and a
descendant through `extends` counts as the same family.

## Qualified names and the chain of scopes

The qualified name of an instance is the qualified name of its scope, a `/`, and its
own name: `France / Lyon / Line 1` is a line, in a city, in a country. The spaces
around `/` do not matter. Moving a city to another country changes the qualified name
of its lines; their relations hold ids and do not change.

## Resolve a reference

`resolveReference` (and `resolveReferenceIn` on an index already loaded) resolves a
text to `{ schema, key }`.

```ts
import { resolveReference } from "@scfloworg/core";

await resolveReference(impl, rest, resolvers, "Assembly");               // France / Paris / Assembly
await resolveReference(impl, rest, resolvers, "Lyon / Line 1");          // France / Lyon / Line 1
await resolveReference(impl, rest, resolvers, "Lyon/Line 1");            // the same
await resolveReference(impl, rest, resolvers, "Line 1", { schema: "line" });
```

1. A uuid is an id and is tried first.
2. Otherwise the text is split on `/`; it matches an instance when its segments are a
   contiguous suffix of the qualified name, each compared with every language of that
   name. `France / Line 1` does not match: a level is missing.
3. One match resolves it.
4. No match is `unresolved_reference`; several are `ambiguous_reference`.

`schema` keeps only the candidates of that schema and its descendants.

## An ambiguous reference

```text
"Line 1" -> ambiguous_reference:
  "Line 1" designates 2 instances: "France / Lyon / Line 1", "France / Paris / Line 1";
  give more of the qualified name
```

`error.details.candidates` lists the full qualified names, so a caller can ask the
person to choose or retry with `Lyon / Line 1`.

## Export the shortest reference

`referenceOf` (and `referenceOfIn`) gives the shortest suffix that is unambiguous in
the dataset now, and the full path:

```ts
referenceOfIn(all, assemblyId);  // { reference: "Assembly", full: "France / Paris / Assembly" }
referenceOfIn(all, lyonLineId);  // { reference: "Lyon / Line 1", full: "France / Lyon / Line 1" }
```

A localized name is written in the first of the given `languages` that has a text.
Any language is accepted back. A file written earlier fails with the candidates when
the dataset has since gained a duplicate; resolution never guesses.

The package `@scfloworg/spreadsheet` applies these rules to rows of sheets: it exports every reference as the shortest name and reads them back, see its [documentation](../../spreadsheet/docs/spreadsheet.md).
