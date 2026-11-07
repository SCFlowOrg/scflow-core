# Declared rules

A rule states what must be true of the instances of a schema. It only refuses:
it never writes. The normative text is
[Rules](spec/meta-model.md#rules) in the specification.

| Rule | Declared as | Checked |
| --- | --- | --- |
| A condition on one instance | `checks` entry with `require` | at the end of the transaction |
| An instance that must exist | `checks` entry with `exists` | at the end of the transaction |
| No two instances share values | `unique` group | at the end of the transaction |
| No cycle in a relation | `acyclic` on the relation | at the end of the transaction |
| A value set once | `set_once` on the property | by the command |
| Consent to a delete | `on_delete: confirm` on the relation | by the `delete` (see [authoring.md](authoring.md), Deleting the target) |

```yaml
name: flow
checks:
  - name: carried_item_domain
    when: { item: { exists: true } }
    require:
      and:
        - item.domain: { in: "${this.source.type.domains}" }
        - item.domain: { in: "${this.destination.type.domains}" }
  - name: flow_ends_hold_item
    when: { item: { exists: true } }
    each: ["${this.source}", "${this.destination}"]
    exists: { schema: holding, with: { actor: "${each}", item: "${this.item}" } }
properties:
  - { name: source, type: actor, mandatory: }
  - { name: destination, type: actor, mandatory: }
  - { name: item, type: item }
```

```yaml
name: holding
unique:
  - name: held_once
    properties: [actor, item]
```

## `checks`

- `when` and `require` are [filters](commands.md#filters) on one instance. An
  operand can be a path on that instance, `"${this.source.type.domains}"`.
- `exists` names a schema and the values of `with`; it holds when at least one
  instance of that schema, own or imported, has them. A value of `with` is a
  literal, `${this.path}` or `${each}`.
- `each`, with `exists` only, is a list (or one `${this...}` giving one): each
  value is tested in turn as `${each}`.
- A path crosses single-valued relations only. There is no quantifier over
  instances.

## `unique`, `acyclic`, `set_once`

- A `unique` group lists direct scalars or single-valued relations. A group with
  a null relation does not count. With `extends`, a group declared on a base
  schema covers its descendants together.
- `acyclic` goes on a single-valued relation to its own schema or an ancestor:
  following it from an instance never leads back to that instance. The rule of a
  breach is named after the property.
- `set_once` lets a value go from no value (a null relation, or `""`, `0`,
  `false`) to a value once. Setting the same value again is accepted; any other
  change or clearing it fails with `constraint_violation` at once.

A schema extending another keeps the `checks` and `unique` groups of its parent
and adds its own.

## When rules are checked

- In an `ApiSession` transaction, the rules are checked by
  `prepareTransaction` (or a commit that prepares). A composite creation may be
  invalid on the way. A breach throws `rule_violation`; the transaction stays
  open and the caller rolls it back.
- A command, a script or a `ScriptSession` run outside a transaction is a
  transaction of its own: a breach undoes every write of that call and throws
  `rule_violation`, and the data version is not bumped. A script is checked once,
  at its end.
- A rule is re-evaluated for the instances written, and for every instance of
  its schema when a path it reads goes through a schema whose instances changed:
  a rule on `flow` reading `item.domain` runs again when an item changes. An
  `exists` rule runs again when an instance of its schema is written or deleted.
- `upgradeDataset` and `upgradeModule` check every rule on every instance; an
  upgrade that breaks one is refused, changing nothing.

`rule_violation` carries `details`: `rule`, `schema` and `key` of the first
breach, and `violations`, the list of every breach found, which an upgrade uses
to give the instances at fault.

## Declarations

Schema processing refuses with `constraint_violation` a rule name declared twice
on a schema, a `checks` entry with both or neither of `require` and `exists`,
`each` without `exists`, a path that crosses a relation to several instances, a
`unique` group naming a path, an array, a map or a generated relation, `acyclic`
on anything but a relation to the schema or an ancestor, and `set_once` with
`constant`, on an array or on a map. The schema of an `exists` that does not
resolve fails with `unknown_schema`. In a module, it is written like a property
type: a short name of the module, or a qualified one.

Not covered yet: rules declared on a facet are not evaluated, and a path does not
cross a virtual relation (see [limitations.md](limitations.md)).
