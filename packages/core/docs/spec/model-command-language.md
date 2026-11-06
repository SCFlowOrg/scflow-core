# The model command language

## Language Model

*Concept.*

*(skeleton — content to be written)*

The modeling language is not a bolted-on API: it is defined the same way everything else in this convention is defined — as a model, i.e. schemas describing entities in a dataset. The entities involved are [Command](#command) and [Command Call](#command), **scripts** (datasets of command calls), and the **interface** a [persistent format](meta-model.md#persistent-formats) must implement to support the language ([Persistence Interface](typescript-reference-implementation.md#persistence-interface)).

## Command

*Definition.*

A command is one operation on the instances of one schema: a `query` reads them, a `create` adds some, an `update` patches the matched ones, a `delete` removes them. It is the unit every caller of the TypeScript API of `@scfloworg/core` (`docs/commands.md`) runs, alone or chained in a [Script](#script).

| property | meaning |
| --- | --- |
| `kind` | `query`, `create`, `update` or `delete` |
| `schema` | the target schema, by a name resolved as in [Names](meta-model.md#names); the command reaches its instances and those of every schema extending it, transitively |
| `namespace` | the empty string (default): the dataset's own instances; a specific import's namespace, or `*` for every namespace: imported instances too, `query` only (see [Import](meta-model.md#import)) |
| `filters` | a [Filter](#filter) selecting the instances to act on; absent: every instance |
| `input` | an array of objects for `create` and `update`; a bare object is shorthand for a one-element array |
| `cascade` | `delete` only: also removes the instances that reach a removed instance through an `on_delete: confirm` relation; false by default |
| `result` | narrows what comes back, see *Result shaping* |

**Authored form.** `kind` and `schema` may be written as one key: the kind names the key and its value names the schema, so `{update: task, filters: {id: t2}, input: {status: done}}` equals `{kind: update, schema: task, filters: {id: t2}, input: {status: done}}`. Exactly one of `kind` or one such key is given. A property outside the table above is refused before anything runs; a command of a [Script](#script) also carries `as`.

**Facets.** The properties of the [facets](meta-model.md#facet) of a schema S are properties of S and of its descendants, under the namespace of the module of the facet: `query` returns them in a nested mapping (`carbon: {co2: 12}`), `filters` and `result.properties` name them by path (`carbon.co2`), and `create` and `update` accept them in `input` as the same nested mapping, all through S. Within that mapping a patch changes only the properties it names, and `null` unsets a value. The first value set creates the instance of the facet, and a `delete` removes it with the instance of S. A facet is not addressable: a command whose `schema` is one is refused with `facet_not_addressable`, before anything runs.

**Writes.** A `create`, `update` or `delete` runs inside an [action](meta-model.md#action). Outside one it is refused with `write_outside_action`, and an action that writes beyond its limit is refused with `write_not_declared`. A `query` needs no action. Commands on the model itself, by a model author, stay below actions.

**Matching.** `query`, `update` and `delete` act on the instances that satisfy `filters`, listed schema by schema (the target first, then the extending schemas), each filtered against its own properties. An `update` or `delete` without `filters` therefore acts on every instance of the schema. Virtual relations (see [Relations](meta-model.md#relations)) are resolved before filtering and before an instance is returned.

**Query.** A query never mutates. Its `before` and `after` are identical copies of the matched instances, subject to *Result shaping*.

**Create.** Each `input` entry is an object naming the properties it sets; the others take their `default_value`, resolved by [Placeholders](meta-model.md#placeholders) at construction. The instance is validated as a whole (`mandatory`, length, `pattern`, `enum`, bounds, exactly one owner for an owned schema) before it is stored. A `shared_by_name` schema requires `name`, is keyed by it and refuses an `id`. Any other schema is keyed by the `id` of the entry, a canonical lowercase uuid that no instance of the schema uses yet, or by a generated uuid when the entry has none. A relation with an `inverse_name` updates the other side, and the instances so changed come back in `updated-before` and `updated-after`.

**Update.** The i-th matched instance takes the patch `input[i mod n]` for n entries, so one entry patches every match and several entries cycle over them. A patch changes only the properties it names. The key property and a `constant` property cannot be patched. A generated (inverse) relation is written through the declaring side. The patched instance is validated as a whole, as on create. An instance left with no owner is deleted, per [Ownership](meta-model.md#ownership), and does not appear in `after`. An `update` with no `input` is refused with `empty_input`.

**Delete.** Each matched instance is removed together with everything it owns; the owned instances come back in `cascade-deleted`. A relation that pointed at a removed instance is cleared on the other side, and the instances so changed come back in `updated-before` and `updated-after`. A relation follows its [`on_delete`](meta-model.md#on-delete), and `cascade: true` makes `confirm` relations cascade, transitively. `restrict` still refuses and `set_null` still clears.

**Text operations.** A patch value for a property of base type `string` (`markdown` included) is either a literal, which replaces the value, or a text operation, which edits the current value in place: a mapping with exactly one of these keys.

| operation | operand | effect |
| --- | --- | --- |
| `append` | a string | the operand is appended to the current value, with no separator added |
| `replace` | `{find, with, all}` | `find` is replaced by `with` |

`find` is a non-empty literal string, matched case-sensitively and without pattern syntax, in the current value. It occurs exactly once, otherwise `text_not_found` (none) or `text_not_unique` (several) refuses the update; `all: true` replaces every occurrence and requires at least one. `with` may be empty, which deletes `find`. A current value of `null` is empty text for `append`; `replace` finds nothing in it. Each matched instance applies the operation to its own current value, so an operation cycles over the matches like any patch. The result is the value the patch sets: constraints (`pattern`, `mandatory`, ...) are checked on it as on a literal, and `before`, `after`, transactions and deltas treat it as an ordinary value change. A mapping with a key other than these, or with several, is refused with `unknown_text_operation`. A text operation on a property that is not a single-valued `string`, or inside a `create`, is refused with `constraint_violation`.

**Map operations.** A patch value for a map property (see [Property](meta-model.md#property), "Map types") is either a literal map, which replaces the whole map, or a map operation: a mapping with exactly one of these keys.

| operation | operand | effect |
| --- | --- | --- |
| `set` | a mapping of entries | each entry replaces the entry of the same key, or is added; the other entries are kept |
| `remove` | an array of keys | each key is removed; a key with no entry is ignored |

A mapping with a single key `set` or `remove`, where that name is not a valid key of the map type, is a map operation; any other mapping is a literal map and is validated as one. A current value of `null` is `{}`. Each matched instance applies the operation to its own map, so an operation cycles over the matches like any patch. Keys and values are validated against the map type, and constraints (`min_length`, ...) are checked on the resulting map; `before`, `after`, transactions and deltas treat it as an ordinary value change. A map operation whose operand has the wrong shape is refused with `invalid_map_operation`. A map operation on a property that is not a map, or inside a `create`, is refused with `constraint_violation`.

**Result.** A command answers with five lists of instances.

| list | holds |
| --- | --- |
| `before` | the matched instances as they were before the command; empty for a `create` |
| `after` | the instances as they are after the command; empty for a `delete` |
| `cascade-deleted` | the instances removed because an instance they belong to was removed |
| `updated-before` | instances of other schemas changed as a side effect, as they were |
| `updated-after` | the same instances, as they are |

**Result shaping.** `result` narrows what comes back without changing what runs: it applies after everything the command does. `properties` lists the properties every returned instance keeps; an empty list keeps the key alone, and an absent `properties` keeps every property. `name` and `id` are always kept, so a returned instance stays addressable. `before` says whether `before` and `updated-before` are filled. Absent, it is `false` for a `query`, whose `before` and `after` are identical copies, and `true` for `create`, `update` and `delete`, whose `before` and `after` differ. `before: true` on a query fills both.

**Exceptions.**

| exception | thrown when |
| --- | --- |
| `missing_command_kind` | the command is not a mapping, or names neither `kind` nor a kind key |
| `ambiguous_command_kind` | several kind keys are given, or `kind` together with a kind key |
| `unknown_command_property` | a property outside `kind`, `schema`, `namespace`, `filters`, `input`, `cascade`, `result`, `as` |
| `unknown_result_option` | `result` is not a mapping, carries a key other than `properties` and `before`, or a value of the wrong type |
| `unknown_schema` | `schema` names no schema of the dataset's model, or is a short name that does not resolve where it is written (see [Names](meta-model.md#names)) |
| `unknown_property` | `result.properties` names a property the target schema does not declare |
| `empty_input` | an `update` carries no `input` |
| `unknown_text_operation` | a text operation has a key other than `append` and `replace`, or several keys |
| `invalid_map_operation` | a map operation's operand is not a mapping (`set`) or not an array of keys (`remove`) |
| `text_not_found` | a `replace` finds no occurrence of `find` |
| `text_not_unique` | a `replace` without `all: true` finds several occurrences of `find` |
| `constraint_violation` | an `input` value or entry is malformed, or the resulting instance breaks a constraint of its schema (`mandatory`, `pattern`, `enum`, bounds, ownership, a patched key or `constant` property, a text or map operation where none applies), or a `create` supplies an `id` that is not a canonical lowercase uuid, already exists, or targets a `shared_by_name` schema |
| `write_outside_action` | a `create`, `update` or `delete` runs outside an action |
| `write_not_declared` | an action writes a schema outside its `writes`, or a property of a facet of another module |
| `invalid_parameters` | the parameters of an action break its JSON Schema, or a `ref` matches no instance or several |
| `rule_violation` | the transaction breaks a [rule](meta-model.md#rules): it gives the name of the rule, the schema and the key of the instance |
| `not_upgrade_locator` | a `schema` or `scalar_type` is changed against a locator that is not an upgrade locator |
| `upgrade_locator` | a data instance is changed against an upgrade locator |
| `facet_not_addressable` | `schema` names a facet |
| *(any Filter exception)* | propagated unchanged, see [Filter](#filter) |

## Filter

*Definition.*

A filter restricts which instances of a [Command](#command)'s `schema` are matched — used by `query`, `update` and `delete` to build the working set (see Command's Processing, step 2). 

```yaml
name: filter
embedded:
description: restricts which instances of a schema match a command
properties:
  - name: and
    type: "[filter]"
  - name: or
    type: "[filter]"
  - name: not
    type: filter
```

As with constraints (see [Constraint](meta-model.md#constraints)), any key in a filter that is not `and`, `or` or `not` is not declared on the `filter` meta-schema — it is interpreted as a **predicate**: the key is a **property path**, the value is the test to apply.

A property path is a dot-separated sequence of property names, navigated the same way as in [Placeholders](meta-model.md#placeholders): the first segment is a property of `schema`, or the namespace of a module with a [facet](meta-model.md#facet) of `schema` followed by a property of that facet (e.g. `carbon.co2`), each following segment reaches into an embedded property, into the entry of a map property by its key (e.g. `display_name.fr`), or across a relation into the target schema's properties (e.g. `assignee.team.name`). An instance with no entry for the key, or with no value for a property of a facet, satisfies no predicate on that path, `ne` included, except `exists`.

A predicate value is either a literal — shorthand for `eq` — or an object of `operator: operand` pairs. Multiple operators on the same property are implicitly and-ed:

```yaml
status: open
priority:
  gte: 3
  lte: 5
```

**Arrays as values.** A bare array is not a set of alternatives. On a property that is not an array, a bare array value, or an array operand of `eq` or `ne`, is refused with `type_mismatch`, as is an operand of `in` that is not an array; a choice between values is written `{in: [...]}`. On an array property, a bare array compares the whole array. Property paths and these operand shapes are checked on the filter itself, before any instance is read, so the refusal comes even when the schema holds no instance.

**Sets.** On a property declared `is_set` (see Property Constraints), a bare array, and the operand of `eq` and `ne` when it is an array, compare the whole value without regard to order: `[b, a]` equals `[a, b]`. `contains` and `exists` behave as on any array property.

**Shape.** A filter is a mapping, at the top of a command as at every level of nesting: `and` and `or` hold an array of mappings, `not` holds one mapping. A filter given as an array or a string, an `and` or `or` that is not an array, or a `not` that is not a mapping is refused with `invalid_filter`, checked on the filter itself before any property path is resolved. Several conditions at one level are several keys of the same mapping, or the elements of an `and`.

**Operators**

| operator | applies to | description |
|---|---|---|
| `eq` | any scalar; relation (by key) | equal to value — implied when a bare literal is given |
| `ne` | any scalar; relation | not equal to value |
| `lt`, `lte` | number, integer, date, date_time, time | less than / less than or equal |
| `gt`, `gte` | number, integer, date, date_time, time | greater than / greater than or equal |
| `in` | any scalar; relation | value is one of the given array |
| `subset_of` | array property | every entry of the value is in the given array; true for an empty value; order and duplicates do not matter |
| `contains` | array property; string | array has the value as an element, or string contains the substring |
| `matches` | string | value matches the regexp |
| `exists` | relation; array; map; property of a facet | relation is not null, array or map is not empty, or the property of a facet has a value |

Relation predicates compare against the target's **key** (see [Keys](meta-model.md#keys)), not the full instance.

**Paths on the right.** An operand can be a path on the instance being tested, written as one [placeholder](meta-model.md#placeholders) starting at `this`: `item.type.domain: {in: "${this.source.type.domains}"}`. It is resolved per instance. Only a whole placeholder that is a plain path is accepted, with no function and no surrounding text, so that a filter stays translatable. `${this...}` is refused with `invalid_filter` otherwise. A missing value on the right satisfies no predicate.

**Combining.** `and` and `or` take an array of nested `filter`; `not` takes a single nested `filter`. `and: []` is vacuously true, `or: []` is vacuously false. A filter with no keys at all (`{}`) matches every instance — this is the `filter` type's default value, used when a command omits `filters`.

```yaml
kind: query
schema: task
filters:
  and:
    - status: open
    - or:
        - assignee: alice
        - priority:
            gte: 3
    - not:
        tags:
          contains: archived
```

**Exceptions.**

| exception | thrown when |
|---|---|
| `invalid_filter` | a filter, or the operand of `and`, `or` or `not`, does not have the shape given in *Shape* |
| `unknown_property` | a predicate's property path does not resolve on `schema` (or on the schema reached by traversing a relation) |
| `invalid_operator` | an operator is used against a property type it doesn't apply to (e.g. `gt` on a `boolean`) |
| `type_mismatch` | a predicate's value cannot be interpreted as the property's type — including an array used as a value on a property that is not an array, and an `in` operand that is not an array |

## Script

*Definition.*

A script is an ordered sequence of steps, executed one after another. You write a script and run it, the way an AI assistant or a REPL user would: create a node, create another node, connect them. A step is usually a [command](#command). A script with parameters, declared as the body of an [action](meta-model.md#action), is a **procedure**.

```yaml
name: script
embedded:
description: an ordered sequence of steps, executed in order
properties:
  - name: parameters
    type: string
    description: the parameters of a procedure, as JSON Schema
  - name: commands
    type: "[script_command]"
    description: the steps to execute in order
  - name: result
    type: string
    description: a placeholder giving the result of the script; the result of its last step when absent
```

A script's steps are not plain [commands](#command) but **script_command**, a small schema that extends `command` for what only a chained step needs.

```yaml
name: script_command
embedded:
extends: command
description: a step of a script
properties:
  - name: as
    type: identifier
    description: names this step's result within the enclosing script, or the current entry of each
  - name: when
    type: filter
    description: the step runs only when this filter holds on the parameters and the named results
  - name: call
    type: string
    description: the id of an action to call
  - name: with
    type: string
    description: the parameters of the called action
  - name: each
    type: string
    description: a placeholder giving an array; do runs once per entry
  - name: do
    type: "[script_command]"
    description: the steps run for each entry
  - name: fail
    type: string
    description: a message; the step refuses the whole script
```

A step is exactly one of a command, a `call`, an `each` with its `do`, or a `fail`. Any other shape is refused with `invalid_script_step`.

```yaml
parameters: { type: object, properties: { source: { type: string }, destination: { type: string }, item: { type: string } } }
commands:
  - create: flow
    input: { source: "${params.source}", destination: "${params.destination}", item: "${params.item}" }
    as: flow
  - call: scflow/hold_item
    with: { actor: "${params.source}", item: "${params.item}" }
    when: { params.item: { exists: true } }
  - call: scflow/hold_item
    with: { actor: "${params.destination}", item: "${params.item}" }
    when: { params.item: { exists: true } }
result: "${flow.after.0}"
```

**Chaining.** A `script_command` may set `as: identifier`, naming its `result` within the script. A later step can reference that name through a [placeholder](meta-model.md#placeholders), e.g. `${n1.after.0.id}`. This is the only mechanism for moving data from one step's result into another step's input — there is no separate "variable" construct.

Naming is only needed when the value isn't already known ahead of time — a generated id, a query result, an aggregate. If the target schema is [`shared_by_name`](meta-model.md#keys), you can usually just pick the name yourself when creating the instance and reference it directly by that name in a later command's `input`, without `as` at all — e.g. creating nodes named `n1` and `n2`, then a flow with `input: [{from: n1, to: n2}]`.

**Parameters.** A procedure reads its parameters as `${params.name}`. An absent parameter resolves like a null value: a property of an `input` that receives it is left out.

**Conditions.** `when` is a [filter](#filter) on the parameters and the named results: the first segment of a path is `params` or an `as` name. A step whose `when` does not hold is skipped, and its `as` name stays unset.

**Calls.** `call` runs an action by id, in the same transaction, with the parameters of `with`. An action calls only the actions of its own module and of its dependencies. Its result is named by `as`, as for a command.

**Loops.** `each` gives an array, and `do` runs once per entry, with the entry named by `as`. A name set inside `do` is local to that run.

**Errors.** `fail` refuses the whole script with `procedure_failed` and its message, and the transaction is rolled back. Its message may hold placeholders.

**Purity.** A procedure follows the [contract of a body](meta-model.md#action): it reads no clock and no random source outside `${now()}` and the keys of the engine, so it can be replayed.

**Processing.** Steps execute in array order. Before each step runs, its `input`, `filters` and `with` are resolved for placeholders against the usual context (see [Placeholders](meta-model.md#placeholders)) plus `params` and the results named so far in the script. A `${this...}` in `filters` is left as it is, since it is resolved per instance (see [Filter](#filter)).

**Result.** A script's result is its `result` when given, otherwise the `result` of its last step.


**Exceptions.**

| exception | thrown when |
|---|---|
| `unknown_reference` | a placeholder references an `as` name that hasn't executed yet, or that doesn't exist in the script |
| `invalid_script_step` | a step is not exactly one of a command, a `call`, an `each` with its `do`, or a `fail` |
| `procedure_failed` | a `fail` step runs |
| `unknown_action` | `call` names no action the script can reach |
| *(any command exception)* | propagated unchanged when a command in `commands` throws — see [Command](#command)'s exceptions |

## Schema Processing

*Feature.*

A schema, property definition, or scalar type is authored as a plain YAML/JSON object: declared meta-schema keys (`name`, `type`, `extends`, `properties`, and so on) are read literally, and any other key is a constraint application — the same rule Filter already uses for predicates. Schema processing is the normalization pass that turns this authored form into an instance matching its meta-schema exactly: every declared key resolved, everything else collected into `constraints`.

**Scope and timing.** Schema processing runs once: when a `schema` or `scalar_type` is added to a module from a transient (YAML/JSON-authored) description, or later updated from one. The modelling-language API exposes a dedicated function for each (see `@scfloworg/core`'s `docs/model-upgrade.md`) that takes the raw description and stores the normalized instance. A `property` definition has no add call of its own — it is always embedded in a schema's `properties`, and is normalized as part of processing that schema. Schema processing does not run when a schema is read back out of the dataset — what's stored is already canonical, so every other part of the interpreter (constraint checking, command processing, and so on) can assume properties and constraints are already fully resolved.

**Update as full replacement.** An `update` on `schema` reads its `input` entry as a complete authored description rather than a property-by-property patch, since a schema's `properties` list is one structure and not a set of independent fields: the stored schema is rebuilt from that description alone, which is where it departs from [Command](#command)'s general rule. A key the description leaves out takes its meta-schema default — `content` becomes empty, `extends` none — so a template a schema carries in `content` belongs in the description that updates it. Properties generated by another schema's `inverse_name` are the exception: an authored description never names them, and they carry through from the stored schema, including those another entry of the same command generated on it.

**Key classification.** Every `key: value` entry in an authored schema, property definition, or scalar type is classified once:
1. `key` names a property already declared on the entity's own meta-schema (`schema` for a schema, `property` for a property definition, `scalar_type` for a scalar type) → an ordinary property value, used as-is.
2. Otherwise → a constraint application, moved into `constraints`. A bare key with no value (YAML null) is a boolean constraint set to `true`.

There is no other case: no markers, nothing to declare on the enclosing entity to change how a key is read.

**Extends resolution.** If `extends` is set on a schema or a scalar type, the parent must be processed first (recursively) — though in practice this will already be true, since the parent has to exist in the module, a dependency or `mcl:core` before it can be named. The child's `properties` (for a schema) and `constraints` are layered on top of copies of the parent's: everything the child doesn't mention carries through unchanged. A child entry with the same `name` as a parent property refines that property rather than replacing it — every key the entry states wins, every key it omits comes from the parent, and their `constraints` layer the same way the schema's own do. `type` is what makes the two the same property, so an override may restate it and may leave it out, and stating a different one → `property_type_change`. Every other property description still requires a `type`. Circular `extends` → `extends_cycle`.

**Facets.** A schema F with `facet_of` is processed as a [facet](meta-model.md#facet) of its target T. Each breach below is a `constraint_violation`: F has a `name` property, or is `shared_by_name`, `embedded` or `is_root`; F takes part in `extends`, or another schema extends it; a property of F is a `mandatory` relation, or carries `inverse_name`, `owns` or `owner`; T is a facet or is `embedded`; a relation of any schema targets F. A property of F named like a property of another facet of the same module on T is refused the same way, and so is a property of T or of a descendant of T named like a namespace in use. The schema of T as stored holds no property of F when F belongs to another module: the engine adds the properties of the facets of the modules a dataset uses when it reads the schema for that dataset. Their values are stored in the instance of F, never in that of T.

**Actions.** Schema processing builds the generated actions of a schema (see [Action](meta-model.md#action)) and checks the declarations, and each breach is a `constraint_violation`: a declared action has no procedure and no bundle; a bundle has no declaration; an id named by `crud` or `updated_by` is not an action of the module; a schema named by `writes` belongs to another module; a module declares the `crud` of a schema of another module; `crud` offers a create or a delete on a facet or a `singleton`, or `updated_by` is set on a `constant` property.

**Rules.** `checks`, `unique`, `acyclic` and `set_once` are validated here, and each breach is a `constraint_violation`: a rule name is declared twice on a schema; a `checks` entry has both `require` and `exists`, or neither; `each` appears without `exists`; a path crosses an array relation; a `unique` group names something other than a direct scalar or single-valued relation; `acyclic` is set on a relation whose target is neither the schema nor an ancestor of it; `set_once` is set with `constant`, on an array or on a map; a rule is set on a schema of another module.

**Out of scope: placeholders.** Schema processing does not resolve `${...}` placeholders in `default_value` — those are left as literal strings on the normalized `property`. Placeholder resolution happens later, at instance construction time, per [Placeholders](meta-model.md#placeholders). Schema processing only has to guarantee the string survives normalization untouched.

**Virtual relations.** When a normalized property carries `inverse_name`, schema processing also updates the *target* schema (the schema named by the property's `type`), adding or extending a property there named `inverse_name`, typed back to this schema, with `is_array` from `inverse_is_array` and `mandatory` from `inverse_is_mandatory`. If a property of that name already exists on the target schema and wasn't itself generated this way → `inverse_name_conflict`. This step runs after both schemas involved have otherwise finished their own processing, since either side may declare the relation. Schemas created by one command are processed together: the target of an inverse relation may be a schema of the same command, placed before or after the declaring schema, or the declaring schema itself. A target found neither in the command nor in the dataset throws `unknown_extends_target`.

The inverse is generated once, on behalf of the schema that declares the relation. Extends resolution above flattens `extends`, so a schema extending that one carries the relation among its own properties; processing it leaves the generated property as it stands, still typed to the declaring schema. A relation's value is the key of an instance of its declared schema or of a schema extending it (see [Relations](meta-model.md#relations)), so that one property accepts the instances of the whole family. A relation an extending schema declares itself generates its own inverse, typed to that extending schema.

**Virtual relations across modules.** When the declaring schema and the target belong to different modules, the target stays unchanged. The generated property is qualified by the namespace of the declaring module (`carbon.emissions`), computed per dataset like the properties of a facet, and optional: `inverse_is_mandatory` is a `constraint_violation`.

**Result.** A normalized `schema`, `property`, or `scalar_type` instance, stored in its module: declared keys read literally, `constraints` holding only resolved `constraint_value` entries. Nothing downstream — command processing, constraint checking, filtering — ever sees the authored (sugared) form again.

**Exceptions.**

| exception | thrown when |
|---|---|
| `unknown_extends_target` | `extends` or `facet_of` names a schema or scalar type that cannot be resolved, or an `inverse_name` relation targets a schema found neither in the command nor in the dataset |
| `extends_cycle` | the `extends` chain of a schema or scalar type loops back on itself |
| `duplicate_property_name` | two entries of `properties` share a `name`, and neither comes from an `extends` override |
| `property_type_change` | a property overriding an inherited one of the same name states a different `type` |
| `inverse_name_conflict` | a virtual relation's target name collides with an existing, non-generated property on the target schema |
| `reference_outside_module` | a schema refers to a module that is neither its own, nor a dependency, nor `mcl:core` (see [Module](meta-model.md#module)) |
| `namespace_conflict` | two modules used in one dataset have the same namespace (see [Names](meta-model.md#names)) |
| `constraint_violation` | a schema breaks the rules of a facet (see *Facets*), or declares a rule that is not valid (see *Rules*), or an action that is not valid (see *Actions*) |

## Examples

*Feature.*

Covers: end-to-end examples of each [command](#command) `kind` — `query`, `create`, `update`, `delete` — against one small shared example model, showing `filters`, the patch/cycling behaviour of `input` on update, the in-place edit of a text property with `append` and `replace`, ownership handling on create, and a [script](#script) chaining several commands together with a named (`as`) result.

All commands below share one dataset, at `locator: tasks-demo`; it is dropped from every example after the first for brevity.

**A single instance shorthand.** `input` for `create`, `update` and `delete` accepts a bare object as shorthand for a one-element array — `input: {status: in_progress}` is equivalent to `input: [{status: in_progress}]`. Anything else that isn't an array (a string, a number, `null`...) is rejected with `constraint_violation`.

**The example dataset.** A `person` is `shared_by_name`, so its key is its `name`. A `task` is `is_root` — the dataset owns it directly — and keyed by a generated `id`, since it is only `shared`, not `shared_by_name`. A `comment` belongs to exactly one `task` through an `owner` relation; `inverse_name` gives `task` a virtual `comments` property for free. `task_status` is a small enum [scalar type](meta-model.md#scalar-types) rather than a bare `string`, so a bad value on `create` or `update` is a `constraint_violation`, not something to check by hand.

```yaml
name: person
shared_by_name:
properties:
  - name: name
    type: identifier
  - name: email
    type: email

name: task_status
extends: string
enum: [open, in_progress, done]

name: task
is_root:
properties:
  - name: title
    type: string
  - name: status
    type: task_status
    default_value: open
  - name: priority
    type: integer
    default_value: 0
  - name: assignee
    type: person
    inverse_name: assigned_tasks
    inverse_is_array:
  - name: tags
    type: "[string]"

name: comment
properties:
  - name: task
    type: task
    owner:
    inverse_name: comments
    inverse_is_array:
  - name: author
    type: person
    mandatory:
  - name: body
    type: markdown
  - name: created_at
    type: date_time
    default_value: ${now()}
```

**Create — people, then tasks.** Two `create` commands seed the dataset. `person` instances key themselves by `name`, so no `id` appears; `task` instances get a generated `id`, shown here as `t1`/`t2`/`t3` for readability. Each `task` input only sets the properties it cares about — `status`, `priority` and `tags` fall back to their `default_value` when omitted.

```yaml
locator: tasks-demo
kind: create
schema: person
input:
  - name: alice
    email: alice@example.com
  - name: bob
    email: bob@example.com
```

```yaml
before: []
after:
  - name: alice
    email: alice@example.com
  - name: bob
    email: bob@example.com
```

```yaml
kind: create
schema: task
input:
  - title: Design the schema processing pass
    priority: 3
    assignee: alice
    tags: [design]
  - title: Write the persistence interface
    assignee: bob
  - title: Draft the command examples
    priority: 5
    assignee: alice
    tags: [docs, urgent]
```

```yaml
before: []
after:
  - id: t1
    title: Design the schema processing pass
    status: open
    priority: 3
    assignee: alice
    tags: [design]
  - id: t2
    title: Write the persistence interface
    status: open
    priority: 0
    assignee: bob
    tags: []
  - id: t3
    title: Draft the command examples
    status: open
    priority: 5
    assignee: alice
    tags: [docs, urgent]
```

**Create — ownership and placeholders.** Creating a `comment` needs a `task` to own it, given directly in `input` by key (`t1`). `created_at` has no explicit input, so its `${now()}` [placeholder](meta-model.md#placeholders) resolves at construction time. Because `comment.task` carries `inverse_name: comments`, `t1` itself changes as a side effect — it goes from `comments: []` to `comments: [c1]` without a command targeting `task` at all, so it shows up in `updated-before`/`updated-after` rather than `before`/`after`.

```yaml
kind: create
schema: comment
input:
  - task: t1
    author: bob
    body: "Should this also cover scalar_type constraints?"
```

```yaml
before: []
after:
  - id: c1
    task: t1
    author: bob
    body: "Should this also cover scalar_type constraints?"
    created_at: "2026-08-10T09:14:02.000Z"
updated-before:
  - id: t1
    title: Design the schema processing pass
    status: open
    priority: 3
    assignee: alice
    tags: [design]
    comments: []
updated-after:
  - id: t1
    title: Design the schema processing pass
    status: open
    priority: 3
    assignee: alice
    tags: [design]
    comments: [c1]
```

**Query.** `query` never mutates anything — `before` and `after` are identical copies of the matched instances. This is the same `filters` shape used as the running example in [Filter](#filter): open tasks that are either assigned to `alice` or at priority 3 or above. It matches `t1` and `t3`; `t2` (assigned to `bob`, priority 0) matches neither branch of the `or`.

```yaml
kind: query
schema: task
filters:
  and:
    - status: open
    - or:
        - assignee: alice
        - priority:
            gte: 3
```

```yaml
before:
  - id: t1
    title: Design the schema processing pass
    status: open
    priority: 3
    assignee: alice
    tags: [design]
    comments: [c1]
  - id: t3
    title: Draft the command examples
    status: open
    priority: 5
    assignee: alice
    tags: [docs, urgent]
    comments: []
after:
  - id: t1
    title: Design the schema processing pass
    status: open
    priority: 3
    assignee: alice
    tags: [design]
    comments: [c1]
  - id: t3
    title: Draft the command examples
    status: open
    priority: 5
    assignee: alice
    tags: [docs, urgent]
    comments: []
```

**Update — patch and cycling.** `filters: {status: open}` matches all three tasks, in creation order `[t1, t2, t3]`, but `input` only has two entries — so `t1` takes `input[0]`, `t2` takes `input[1]`, and `t3` cycles back to `input[0]`. Each input is a patch: only the keys it names change, everything else on the matched instance is left alone (`t1` keeps `priority: 3`, `t3` keeps `priority: 5`). Giving more inputs than matched instances works the same way in reverse — the extra ones are simply never reached, per [Command](#command)'s processing rules.

```yaml
kind: update
schema: task
filters:
  status: open
input:
  - status: in_progress
  - status: in_progress
    priority: 1
```

```yaml
before:
  - id: t1
    title: Design the schema processing pass
    status: open
    priority: 3
    assignee: alice
    tags: [design]
  - id: t2
    title: Write the persistence interface
    status: open
    priority: 0
    assignee: bob
    tags: []
  - id: t3
    title: Draft the command examples
    status: open
    priority: 5
    assignee: alice
    tags: [docs, urgent]
after:
  - id: t1
    title: Design the schema processing pass
    status: in_progress
    priority: 3
    assignee: alice
    tags: [design]
  - id: t2
    title: Write the persistence interface
    status: in_progress
    priority: 1
    assignee: bob
    tags: []
  - id: t3
    title: Draft the command examples
    status: in_progress
    priority: 5
    assignee: alice
    tags: [docs, urgent]
```

**Update — single-instance shorthand.** Targeting exactly one instance, `input` can be given as a bare object instead of a one-element array — the two are equivalent.

```yaml
kind: update
schema: task
filters:
  id: t2
input:
  status: done
```

```yaml
before:
  - id: t2
    title: Write the persistence interface
    status: in_progress
    priority: 1
    assignee: bob
    tags: []
after:
  - id: t2
    title: Write the persistence interface
    status: done
    priority: 1
    assignee: bob
    tags: []
```

**Update — text operations.** A patch value for a `string` property can edit the current value in place instead of replacing it (see [Command](#command)'s *Text operations*), so a long value is never sent again to change a few words. `replace` swaps exactly one occurrence of `find`, and `append` adds to the end with no separator of its own. The two commands below target different tasks, each editing its own current title.

```yaml
kind: update
schema: task
filters:
  id: t2
input:
  title:
    replace:
      find: interface
      with: interface contract
```

```yaml
before:
  - id: t2
    title: Write the persistence interface
    status: done
    priority: 1
    assignee: bob
    tags: []
after:
  - id: t2
    title: Write the persistence interface contract
    status: done
    priority: 1
    assignee: bob
    tags: []
```

```yaml
kind: update
schema: task
filters:
  id: t3
input:
  title:
    append: ' (v2)'
```

```yaml
before:
  - id: t3
    title: Draft the command examples
    status: in_progress
    priority: 5
    assignee: alice
    tags: [docs, urgent]
after:
  - id: t3
    title: Draft the command examples (v2)
    status: in_progress
    priority: 5
    assignee: alice
    tags: [docs, urgent]
```

A `replace` whose `find` occurs twice in the value is refused with `text_not_unique`, and one whose `find` occurs nowhere with `text_not_found`; `all: true` next to `find` and `with` replaces every occurrence. Nothing is written when the command is refused.

**Delete — cascade.** Deleting `t1` also removes `c1`, since `c1`'s `owner` relation points at `t1` and an owned instance cannot outlive its owner (see [Ownership](meta-model.md#ownership)). The deleted comment shows up in `cascade-deleted`, not `after` — and by the time this result is read, the keys inside `before`/`cascade-deleted` no longer resolve to anything.

```yaml
kind: delete
schema: task
filters:
  id: t1
```

```yaml
before:
  - id: t1
    title: Design the schema processing pass
    status: in_progress
    priority: 3
    assignee: alice
    tags: [design]
    comments: [c1]
after: []
cascade-deleted:
  - id: c1
    task: t1
    author: bob
    body: "Should this also cover scalar_type constraints?"
    created_at: "2026-08-10T09:14:02.000Z"
```

**Script — chaining a create into a create.** `task` is keyed by a generated `id`, not a name picked at creation, so there's no way to reference the new task in a later command except by naming its result: `as: new_task`, then `${new_task.after.0.id}` in the next command's `input`. This is the case [Script](#script) contrasts with `shared_by_name` schemas like `person`, where you'd just reuse the name you chose instead of naming a result at all. The script's own result is the result of its last command — the `comment` create.

```yaml
commands:
  - as: new_task
    kind: create
    schema: task
    input:
      - title: Ship the REPL
        assignee: alice
  - kind: create
    schema: comment
    input:
      - task: ${new_task.after.0.id}
        author: bob
        body: "Linked to the persistence interface work."
```

```yaml
before: []
after:
  - id: c2
    task: t4
    author: bob
    body: "Linked to the persistence interface work."
    created_at: "2026-08-10T09:16:40.000Z"
updated-before:
  - id: t4
    title: Ship the REPL
    status: open
    priority: 0
    assignee: alice
    tags: []
    comments: []
updated-after:
  - id: t4
    title: Ship the REPL
    status: open
    priority: 0
    assignee: alice
    tags: []
    comments: [c2]
```
