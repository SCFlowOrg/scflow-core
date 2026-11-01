# Authoring a model

A schema and a scalar type are authored as JSON and created through an upgrade
locator (see [model-upgrade.md](model-upgrade.md)). A key of an authored schema or
property that the meta-model does not declare is a **constraint**; `true` switches
a boolean one on.

```ts
const upgrade = await createUpgradeLocator("js:app");
await runScript(upgrade, { commands: [
  { kind: "create", schema: "scalar_type", input: [
    { name: "task_status", extends: "string", enum: ["open", "in_progress", "done"] },
  ] },
  { kind: "create", schema: "schema", input: [
    { name: "person", shared_by_name: true, properties: [
      { name: "name", type: "identifier" },
      { name: "email", type: "email" },
    ] },
    { name: "task", is_root: true, ui_access: "editable", properties: [
      { name: "title", type: "string", mandatory: true },
      { name: "status", type: "task_status", default_value: "open" },
      { name: "tags", type: "[string]" },
      { name: "assignee", type: "person", inverse_name: "assigned_tasks",
        inverse_is_array: true },
    ] },
    { name: "comment", properties: [
      { name: "task", type: "task", mandatory: true, owner: true,
        inverse_name: "comments", inverse_is_array: true },
      { name: "body", type: "markdown" },
      { name: "created_at", type: "date_time", default_value: "${now()}" },
    ] },
  ] },
] });
await upgradeDataset("js:app", upgrade);
```

Create a scalar type before the schemas that name it.

## Schemas and keys

| Constraint | Effect |
| --- | --- |
| `shared_by_name` | Instances are shared and keyed by their `name` |
| `is_root` | Instances are not owned; the dataset owns them |
| `embedded` | Instances live inside their owner and are not shared |
| `singleton` | At most one instance in the dataset; a `create` of a second one fails with `constraint_violation` |
| `constant` | Instances are immutable after creation |
| `observable` | Instances are tracked for change notifications; incompatible with `embedded` (see [observability.md](observability.md)) |
| `extends: "schema"` | Inherits the properties and constraints of another schema |
| `ui_access` | `hidden`, `read_only` (default) or `editable`: how a user interface may expose the instances |

- A schema that is shared but not `shared_by_name` has an `id`, a generated uuid or
  the uuid a `create` supplies; `id` and `key` are reserved property names. The key
  of an instance cannot change. An instance created before uuid ids keeps its
  `<schema>_<n>` id, which stays valid.
- A schema that is neither `is_root` nor `embedded` is owned: each instance has
  exactly one owner, through a relation marked `owner`. An instance left with no
  owner is deleted. The relation may target a base schema: deleting an instance of
  any schema extending the target deletes the instances that name it as their owner.

### UI access

`ui_access` is a hint for user interfaces. Commands ignore it: an `update` of a
`read_only` property succeeds. A schema without `ui_access` is `read_only`. A
property has no default level: it takes its schema's level, may restrict it and
never exceeds it. A value other than the three levels, on a schema or on a
property, fails with `constraint_violation` when the schema is created or updated.
`uiAccessOf` computes the effective level of a schema or of one of its properties;
its doc comment states the rules.

## Properties and scalar types

| Key | Effect |
| --- | --- |
| `type` | `string`, `number`, `integer`, `boolean`, a scalar type, a schema (a relation), `[type]` for an array |
| `default_value` | Value taken when the property is left out; may hold a `${...}` placeholder |
| `mandatory` | A relation cannot be null |
| `constant` | Fixed at creation |
| `is_array`, `min_length`, `max_length` | Array of scalars, and its bounds |
| `is_set` | Set of distinct values of an enum scalar type, in no meaningful order; implies `is_array` (see [Sets](#sets)) |
| `is_unique` | Array of distinct scalar values, in the order given; implies `is_array` (see [Unique arrays](#unique-arrays)) |
| `observable` | On a relation of an `observable` schema: a change of the target notifies the instance (see [observability.md](observability.md)) |
| `ui_access` | Level of this property, never above the schema's |

A scalar type refines a base type: `enum`, `pattern`, `min_length`, `max_length`,
`minimum`, `maximum`, `exclusive_minimum`, `exclusive_maximum`, `multiple_of`,
`markdown`.

### Sets

A property declared `is_set` holds distinct values of an enum scalar type, and the
order of the values carries no meaning.

```ts
{ name: "colors", type: "color", is_set: true, max_length: 2 }   // color: enum [red, green, blue]
{ name: "kinds", type: "string", enum: ["a", "b"], is_set: true }
```

- `is_set` needs a scalar property whose constraints include `enum`, from its scalar
  type or from the property itself. A relation, a map and a property without `enum`
  are refused with `constraint_violation` when the schema is created or updated.
- It implies `is_array`: the processed property carries both, so `min_length` and
  `max_length` apply and count entries. The default is the empty set.
- A `create` or `update` holding the same entry twice, or an entry outside the
  `enum`, fails with `constraint_violation`.
- The stored value lists its entries in the declaration order of the `enum`,
  whatever the order of the input, so two equal sets are stored identically. A value
  stored before `is_set` was set keeps its stored order until the instance is next
  written.
- A filter compares a set without regard to order (see [commands.md](commands.md),
  Filters).
- Setting `is_set` on a property whose stored values hold a duplicate is an
  incompatible model change (see [model-upgrade.md](model-upgrade.md)).

### Unique arrays

A property declared `is_unique` holds an array of distinct scalar values that keeps
the order given.

```ts
{ name: "tags", type: "string", is_array: true, is_unique: true }
{ name: "codes", type: "[integer]", is_unique: true, max_length: 5 }
```

- `is_unique` needs a scalar property, of any type, with no `enum`. A relation or a
  map is refused with `constraint_violation` when the schema is created or updated.
- It implies `is_array`: the processed property carries both, so `min_length` and
  `max_length` apply and count entries. The default is the empty array.
- A `create` or `update` holding the same entry twice fails with
  `constraint_violation`. Entries are compared as written: `"North"` and `"north"`
  are two entries.
- The entries are stored in the order given, unlike a set. A property that is both
  `is_set` and `is_unique` behaves as a set.
- A filter compares a unique array in order, like any array.
- Setting `is_unique` on a property whose stored values hold a duplicate is an
  incompatible model change for those instances (see
  [model-upgrade.md](model-upgrade.md)).

### Map types

A property typed `{K: V}` holds a map: unordered entries, each key of the
string-based scalar type `K` unique, each value of the scalar type `V`. In YAML
the type is a quoted string, so it is not read as a mapping.

```ts
{ name: "synonyms", type: "{language_code: string}" }
{ name: "display_name", type: "localized_string", min_length: 1 }
```

`localized_string` is `{language_code: string}`, `localized_markdown` is
`{language_code: markdown}`, and `language_code` is a built-in scalar type
(`xx` or `xx-XX`). The dataset holds every language and a query returns the whole
map: the reader chooses the language to show.

- The default and the null value are `{}`.
- `default_value`, `null_value`, `is_array`, `is_content` and `is_folder` on a map,
  and a relation, an array or another map as `K` or `V`, are refused with
  `constraint_violation`.
- `min_length` and `max_length` count entries.
- A key is validated against `K` and a value against `V`, without coercion: the
  number `5` is not the string `"5"`.
- An `update` edits one entry with `set` or `remove` (see
  [commands.md](commands.md)), and a filter reaches an entry as `display_name.fr`.

## Relations

A relation is a property whose type is a shared schema; its value is the key of
an instance of that schema or of a schema extending it. It may be null, and it is
single-valued.

| Constraint | Effect |
| --- | --- |
| `mandatory` | The relation cannot be null |
| `owner` | The target owns this instance |
| `extension` | The declaring schema extends the target, see [Extensions](#extensions); implies `mandatory` and `owner` |
| `inverse_name` | Generates the inverse relation on the target schema and on every schema extending it |
| `inverse_is_array` | The inverse relation holds several instances |
| `on_delete` | What the deletion of the target does to this instance: `restrict`, `cascade` or `set_null`, see [Deleting the target](#deleting-the-target) |

The only way to reach several instances is an inverse relation with
`inverse_is_array`. A many-to-many link is a schema of its own, holding one
relation to each side. An inverse relation is read, filtered and written like a
declared one, and is never stored. The target of an inverse relation may be a
schema created by the same command, before or after the declaring schema.

### Deleting the target

`on_delete` says what happens to an instance when the target of its relation is
deleted.

| Value | Effect |
| --- | --- |
| `restrict` | The `delete` fails with `constraint_violation` and removes nothing |
| `cascade` | The instance is deleted too, and reported in `cascade-deleted` |
| `set_null` | The relation is cleared; the instance comes back in `updated-before` and `updated-after` |

```ts
{ name: "member", properties: [{ name: "team", type: "team", mandatory: true }] }                       // restrict
{ name: "badge", properties: [{ name: "team", type: "team", mandatory: true, on_delete: "cascade" }] }  // cascade
{ name: "note", properties: [{ name: "team", type: "team" }] }                                          // set_null
```

- Without `on_delete`, a `mandatory` relation is `restrict` and any other relation
  is `set_null`.
- `set_null` on a `mandatory` relation, `on_delete` on an `owner` or `extension`
  relation (its owner already removes the instance), `on_delete` on a property that
  is not a relation and a value other than the three are refused with
  `constraint_violation` when the schema is created or updated.
- A `restrict` is checked before anything is written, over everything the `delete`
  removes. An instance the same `delete` removes, an owned one or one reached by
  `cascade`, does not block it.
- An instance deleted by `cascade` applies the same rules to what it owns and to
  what references it.

### Extensions

A relation declared `extension` makes its schema an *extension* of the relation's
target: the properties of the extension are seen as properties of the target, in
the schema of the target and in every command on it.

```js
{ name: "task", shared_by_name: true, properties: [{ name: "name", type: "identifier" }, { name: "title", type: "string" }] }
{
  name: "task_billing",
  properties: [
    { name: "task", type: "task", extension: true },
    { name: "rate", type: "integer", default_value: 10 },
  ],
}
```

A task now has a `rate`: `create` takes it, `query` returns it, a filter and
`result.properties` name it, and `update` changes it. Several extensions of the
same target add their properties side by side.

- `extension` implies `mandatory` and `owner`: the instance of the target owns its
  instance of the extension, which is created with it, from the defaults and the
  values of the `input`, and deleted with it. The instance of the extension is
  stored under the extension schema, with the key of the instance it extends, and
  is never reported in `cascade-deleted`.
- An extension has one `extension` relation and no other `owner`. It has no `name`
  and no key of its own, and is not `shared_by_name`, `embedded` or `is_root`.
  Every other property is a relation that is not `mandatory`, an array, a map, or a
  scalar with a `default_value`; none carries `inverse_name`, `owns` or `owner`.
  The `extension` relation takes no `is_array` and no `inverse_*`.
- The schema of the target, and every schema extending it, lists the properties of
  its extensions, each tagged by the internal constraint `__extension`. A property
  of an extension named like a property of the target, of a schema extending it or
  of another extension of it, in either order of creation, fails with
  `constraint_violation`.
- An extension schema cannot be extended and no relation can target it; a command
  whose `schema` is an extension schema fails with `extension_not_addressable`.
- Adding an extension to a populated dataset is a compatible upgrade: the instances
  that exist get their extension instance, from the defaults (see
  [model-upgrade.md](model-upgrade.md)).

Every breach of a rule on the extension schema is a `constraint_violation` raised
when the schema is created or updated, except an unknown target, which is
`unknown_extends_target`.

## Placeholders

A `${...}` placeholder in a `default_value` resolves when an instance is
created, in the order of the properties. A path starts at `this` (the instance
under construction) and the functions are `to_display_name(s)`, `now()`,
`year(d)`, `month(d)` and `day(d)`.
