# Observability

A schema with the `observable` constraint is tracked: a create, an update or a
delete of one of its instances is reported to the listeners registered with
`subscribeObservable(locator, listener)`. The constraint is incompatible with
`embedded`, because an embedded instance has no key to name in a `(schema, key)`
entry; the combination fails with `constraint_violation`.

## Subscribing

`subscribeObservable` returns the function that removes the listener; nothing else
removes it.

- A listener is keyed by `locator` alone, independent of any `ApiSession`. It may be
  registered before a dataset exists at `locator`, or after one has been deleted,
  and it stays registered: it fires on whatever happens next there, `restoreDataset`
  included.
- The listener receives an `ObservableChange`. The whole change of a locator is
  delivered as it is: no per-instance filtering is done, and a subscriber decides
  whether a change concerns it.

## Notifications

- `{ kind: "delta", changes }` is sent once per outermost `commitTransaction`,
  including a transaction made of a `revert`. `changes` is an `ObservableDelta`: one
  entry per touched instance of an `observable` schema, as
  `{ schema, key, before, after, via? }`. `before` is `null` for a created instance
  and `after` for a deleted one; both are present for an update.
- An entry exists for every instance the transaction changed: the instances a
  command targeted, the instances removed by a cascade, the instances changed only
  as the side effect of a generated relation, and the instances changed by any
  command of a script. For each `(schema, key)` the entry keeps the earliest `before`
  and the latest `after` of the transaction; an instance created and deleted in the
  same transaction has no entry.
- `{ kind: "reset" }` is sent directly by `initDataset`, `restoreDataset` and
  `deleteDataset`, and carries no changes: everything at `locator` may have
  changed.
- `bumpMajorVersions` sends nothing, since it changes version metadata only. A
  dataset rename is not reported.
- A locator whose format does not support transactions never produces a `delta`:
  every command commits immediately, outside any transaction.

## Related changes

The `observable` constraint on a relation property makes the instances that point
at a changed instance observable too.

- It is valid only on a relation property of a schema that itself carries
  `observable`; otherwise the schema is refused with `constraint_violation`. The
  declaring schema is the one the relation is defined on, and the constraint has no
  link with the `owner` mechanism. The relation's target schema does not need
  `observable`.
- When the transaction changed the target of the relation, every instance of the
  declaring schema whose relation currently points at that target gets its own entry
  in the same `delta`, with `via` set to the property name and `before` equal to
  `after`, both the instance's current value.

For example, `node.site` is a relation from `node` (schema-level `observable`, and
`observable` on the `site` property) to `site`. When a `site` instance changes,
every `node` pointing at it receives
`{ schema: "node", key, before: X, after: X, via: "site" }`, in addition to the
entry of `site` itself when `site` is `observable`.

- An instance that was also changed directly in the transaction keeps only its
  ordinary entry, without `via`: it never gets a second, related entry.
- Propagation covers one hop. A related entry is not propagated through another
  `observable` relation.
