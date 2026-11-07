# Commands, filters and scripts

## Commands

A command is one operation on the instances of one schema.

```ts
{ kind: "update", schema: "task", filters: { status: "open" },
  input: { status: "in_progress" }, result: { properties: ["title", "status"] } }
```

| Key | Meaning |
| --- | --- |
| `kind` | `query`, `create`, `update` or `delete` |
| `schema` | Target schema; the command also reaches the schemas extending it |
| `filters` | A filter selecting the instances to act on; absent: every instance |
| `input` | An object or an array of objects, for `create` and `update` |
| `result` | Narrows what comes back: `properties` and `before` |
| `namespace` | `""` (default) for the dataset's own instances; the namespace of an import for its instances; `*` for every instance. Any value other than `""` is for `query` only (see [datasets.md](datasets.md), Imports) |

`kind` and `schema` may be written as one key whose name is the kind: `{ update:
"task", filters, input }`. A key outside the table is refused before anything runs.
The error codes of a failing command are documented on `ErrorCode`.

### Behaviour of each kind

- **query** never changes anything. `before` and `after` hold the same copies.
- **create** takes one entry of `input` per instance. A property left out takes
  its `default_value`. The instance is validated as a whole before it is stored.
  A `shared_by_name` schema requires `name` and refuses an `id`. Any other shared
  schema takes the `id` of the entry, a canonical lowercase uuid that no instance of
  the schema uses yet, or gets a generated uuid when the entry has none. A malformed
  or already used `id` fails with `constraint_violation`.
- **update** gives the i-th matched instance the patch `input[i mod n]` for n
  entries: one entry patches every match, several entries cycle over them. A
  patch changes only the properties it names. A key or a `constant` property
  cannot be patched. An `update` without `input` is refused.
- **delete** removes the matched instances and everything they own. What happens to
  an instance whose relation points at a removed instance follows the `on_delete`
  of that relation (see [authoring.md](authoring.md), Deleting the target): a
  `mandatory` relation refuses the delete unless it says otherwise, nothing being
  removed, and any other relation is cleared.
- `update` and `delete` without `filters` act on every instance of the schema.
- The properties of the **extensions** of a schema (see [authoring.md](authoring.md),
  Extensions) are properties of that schema in every kind: `query` returns them,
  filters, including a path across a relation, and `result.properties` name them,
  and `create` and `update` take them. A command whose `schema` is an extension
  schema fails with `extension_not_addressable`.

### Result

A command answers with five lists of instances:

| List | Holds |
| --- | --- |
| `before` | The matched instances as they were; empty for a `create` |
| `after` | The instances as they are; empty for a `delete` |
| `cascade-deleted` | Instances removed because their owner was removed, or through a `cascade` relation |
| `updated-before` | Instances of other schemas changed as a side effect, as they were |
| `updated-after` | The same instances, as they are |

`result.properties` lists the properties kept in every returned instance; `[]`
keeps the key only, absent keeps all. `name` and `id` are always kept.
`result.before` says whether `before` and `updated-before` are filled: `false` by
default for a `query`, `true` for the other kinds.

### Text operations

A patch value for a `string` or `markdown` property may edit the current value
in place instead of replacing it:

```ts
{ kind: "update", schema: "task", filters: { id: "t2" },
  input: { title: { replace: { find: "draft", with: "final" } } } }
{ kind: "update", schema: "task", filters: { id: "t2" },
  input: { title: { append: " (v2)" } } }
```

- The mapping carries exactly one key, `append` or `replace`; any other key, or
  several keys, fails with `unknown_text_operation`.
- `find` is a non-empty literal, case-sensitive, matched in the current value;
  occurrences are counted without overlap. It must occur exactly once, otherwise
  the update is refused (`text_not_found`, `text_not_unique`); `all: true` replaces
  every occurrence and requires at least one. `with` may be `""`.
- `append` adds to the end with no separator; `null` counts as `""`.
- The result is validated like a literal value: an operation that breaks a
  `pattern` is refused and the stored value is unchanged.
- A malformed operand (an `append` that is not a string, a `replace` without a
  string `find` or `with`, an empty `find`, an unknown key inside `replace`, an
  `all` that is not a boolean) fails with `constraint_violation`, and so does a
  text operation inside a `create` or on a property that is not a single-valued
  `string`.
- Each matched instance applies the operation to its own value; with several
  `input` entries the usual cycling applies. See [limitations.md](limitations.md)
  for a refusal on a later instance.

### Map operations

A patch value for a map property (see [authoring.md](authoring.md), "Map types")
is either a literal map, which replaces the whole map, or a map operation:

```ts
{ kind: "update", schema: "actor_type", filters: { name: "plant" },
  input: { display_name: { set: { fr: "Usine" } } } }
{ kind: "update", schema: "actor_type", filters: { name: "plant" },
  input: { display_name: { remove: ["de"] } } }
```

- `set` takes a mapping of entries: each replaces the entry of the same key, or is
  added, and the other entries are kept.
- `remove` takes an array of keys: each is removed, and a key with no entry is
  ignored.
- A mapping with the single key `set` or `remove` is an operation only when that
  name is not a valid key of the map type; any other mapping is a literal map and
  is validated as one. A map keyed by `identifier` takes `set` as an ordinary key.
- A current value of `null` is `{}`. Each matched instance applies the operation
  to its own map, with the usual cycling over several `input` entries.
- Keys, values and the `min_length` and `max_length` of the property are checked on
  the resulting map. An operand of the wrong shape fails with
  `invalid_map_operation`; a map operation inside a `create`, or on a property that
  is not a map, fails with `constraint_violation` (on a `string` property, a
  mapping with another key fails with `unknown_text_operation`).

## Filters

A filter is a mapping at every level. A key is a property path, `and`, `or` or
`not`. A literal value means `eq`; an object holds `operator: operand` pairs,
and several operators on one property are and-ed.

```ts
filters: {
  and: [
    { status: "open" },
    { or: [{ assignee: "alice" }, { priority: { gte: 3 } }] },
    { not: { tags: { contains: "archived" } } },
  ],
}
```

| Operator | Applies to | Matches when |
| --- | --- | --- |
| `eq`, `ne` | scalar; relation (by key) | equal, not equal |
| `lt`, `lte`, `gt`, `gte` | number, integer, date, date_time, time | ordered comparison |
| `in` | scalar; relation | the value is one of an array |
| `contains` | array property; string | the array has the element, the string has the substring |
| `matches` | string | the value matches the regexp |
| `exists` | relation; array; map | the relation is not null, the array or the map is not empty |

- A property path is dot-separated and crosses relations: `assignee.team.name`.
- A path reaches the entry of a map property by its key: `display_name.fr`; a path
  that goes on after the key fails with `unknown_property`. An
  instance with no entry for the key satisfies no predicate on the path, `ne`
  included; `not` matches it. On the whole map, `eq` and `ne` ignore the order of
  the entries and `exists` tells whether the map has an entry.
- A relation is compared with the **key** of its target, not the instance.
- A bare array is not a set of alternatives: write `{ in: [...] }`. On a property
  that is not an array, a bare array is refused. On an array property it keeps its
  meaning: equality of the whole array.
- On an `is_set` property (see [authoring.md](authoring.md), Sets), a bare array and
  the operands of `eq`, `ne` and `in` compare without regard to order: `[b, a]`
  equals `[a, b]`. `contains` and `exists` are unchanged.
- `and: []` is true, `or: []` is false, `{}` matches every instance.
- A filter that is an array or a string, or an `and` that is not an array, is
  refused before any instance is read.
- `checkFilter` checks every filter against the schema before the first instance is
  read, even when the schema holds no instance: a path that does not resolve fails
  with `unknown_property`, and an array used as a value fails with `type_mismatch`,
  with a message suggesting `{ "<path>": { "in": [...] } }`. The rules are in the
  doc comment of `checkFilter`.

## Scripts

A script runs commands in order on one dataset. A command names its result with
`as`; a later `input` or `filters` reads it with a placeholder.

```ts
await runScript(doc, { commands: [
  { as: "new_task", kind: "create", schema: "task", input: [{ title: "Ship" }] },
  { kind: "create", schema: "comment",
    input: [{ task: "${new_task.after.0.id}", author: "bob", body: "Linked" }] },
] });
```

- The result of a script is the result of its last command.
- `as` is only needed for a value not known in advance, such as a generated
  `id`. A `shared_by_name` instance is referenced by the name you chose.
- A placeholder is `${name.path}`; in a path over an array, `0` selects an entry,
  `*` maps the rest of the path over every entry, and a name alone means entry
  `0`.
- A placeholder that names an `as` not yet run is refused. When a command fails,
  the script stops and the commands already run are not rolled back: wrap the
  script in a transaction to make it atomic.
- A `ScriptSession` (`createScriptSession(locator)`) runs one command at a time and
  keeps the named results in `variables`. It loads the model when it opens.

## Examples

One model, `person`, `task` and `comment` as in [authoring.md](authoring.md), in
the dataset `doc = "js:app/doc1"`. `t1`, `t2` and `c1` stand for generated ids.

**Create** people, then tasks; unset properties take their defaults.

```ts
await runCommand(doc, { kind: "create", schema: "person", input: [
  { name: "alice", email: "alice@example.com" }, { name: "bob" },
] });
await runCommand(doc, { kind: "create", schema: "task", input: [
  { title: "Design", assignee: "alice", tags: ["design"] },
  { title: "Write", assignee: "bob" },
] });
```

**Create an owned instance.** `task` is given by key; the owner `t1` comes back
in `updated-before` and `updated-after` because its `comments` changed.

```ts
await runCommand(doc, { kind: "create", schema: "comment",
  input: [{ task: "t1", body: "Cover scalar types too?" }] });
```

**Query** with a filter and a narrowed result.

```ts
const { after } = await runCommand(doc, {
  kind: "query", schema: "task",
  filters: { assignee: "alice", status: { in: ["open", "in_progress"] } },
  result: { properties: ["title", "status"] },
});
```

**Update** one instance, then every open task with cycling patches.

```ts
await runCommand(doc, { kind: "update", schema: "task",
  filters: { id: "t2" }, input: { status: "done" } });
await runCommand(doc, { kind: "update", schema: "task", filters: { status: "open" },
  input: [{ status: "in_progress" }, { status: "in_progress", priority: 1 }] });
```

**Delete** with a cascade: `c1` comes back in `cascade-deleted`.

```ts
await runCommand(doc, { kind: "delete", schema: "task", filters: { id: "t1" } });
```

**Dump and restore** a dataset, into another format if needed.

```ts
const dump = await dumpDataset(doc, "json");
await restoreDataset("js:app/doc2", dump, "json");
```

**Upgrade** and **transaction**: see [model-upgrade.md](model-upgrade.md) and
[sessions.md](sessions.md).
