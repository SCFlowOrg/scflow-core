# Conventions of the actions

The conventions every action of `scflow:core` follows. The catalogue of the
actions, with their parameters and example calls, is generated: see
[[scflow/actions]]; the concepts they work on are in [[scflow/concepts]].

- **Identifiers**: `scflow/<action_name>` (lowercase with underscores).
- **Flexible Reference Resolution (ID or Name)**: To streamline AI calling and human scripting, a reference to an entity that has a `display_name` (actor, actor type, scope, location, item, item type, transformation, transformation type, conversion) accepts either its id or its display name. The id is tried first; otherwise the name must match exactly the `display_name` of one entity, in any language. No match is an error, and several matches are an error that lists the candidate ids. These references are parameters with the keyword `ref`, resolved by the registry before the body runs: a value that matches no instance or several is refused with `invalid_parameters`. An instance that has no name, such as an `item_at_actor`, can only be given by its id.
- **Atomic Transactions**: An action either succeeds completely or rolls back without leaving partial mutations in the model dataset. The action opens no transaction itself: the host runs it inside one.
- **Multilingual Support**: Text fields (`display_name`, `description`) accept either a plain string or a localized map `Record<string, string>`. An action receives no active language, so a plain string `s` is stored in the source language of the dataset, the first of its `languages`: `{ fr: s }` for `["fr", "en"]`, and `{ en: s }` when the dataset states none.
- **Parameter validation**: The registry checks `parameters` against their JSON Schema before the body runs and refuses a breach with `invalid_parameters`, so a body validates nothing by hand.
- **CRUD parameters**: An action that takes the place of a CRUD operation of a schema, named by the `crud` of that schema, follows the CRUD parameters of the meta-model (Action): a create takes the property names, an update takes `id` and the property names, and a delete takes `id` and `cascade`. A create takes every property of its schema, `tags` included.
- **Write limit**: Each action declares the schemas it writes in `writes`; a write outside them is refused with `write_not_declared`.
- **Read actions**: An action that only queries declares `kind: "read"`. The host runs it outside any undo transaction, so it writes nothing. The other actions are mutations (`kind: "action"`, the default).

### Rules

The [network rules](spec/implementation.md#network-rules) are declared on the schemas. The engine checks them at the end of the transaction of an action, and a breach refuses the whole action with `rule_violation`, whose details give `rule`, `schema` and `key`. A change of any instance that a rule reads is covered: changing the type of an actor or of an item is refused when an item it holds or carries no longer fits. A rule only refuses, so the actions still write what a rule requires, such as the holdings of the two ends of a flow.

### Deletion and cascade

Every delete action, `scflow/remove_note` and `scflow/release_held_item` included, takes `id` and `cascade` (boolean, default `false`). `scflow/delete_flow` and `scflow/remove_note` accept `cascade` for consistency and it changes nothing. With `cascade: true`, `scflow/release_held_item` deletes the transformation lines that use the record. Without `cascade`, the action throws an error that counts the dependents and deletes nothing. With it, the action deletes the dependents first, in dependency order (transformation lines, conversions, held items, transformations, flows, actors from the deepest child to the root, items), then the target, so the engine never meets a restricted reference.

The notes of an entity are owned by it: deleting an entity deletes its notes, whatever `cascade` says, and a delete action never lists them as dependents. A deletion therefore removes the notes of the target and of every dependent it deletes.
