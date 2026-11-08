# SCFLOW Model Actions (`scflow-core`)

This document defines the specification and catalog of **Model Actions** for the SCFLOW domain.

These actions serve as high-level semantic building blocks shared across:
1. **The User Interface (UI)**: Executed directly on canvas drag-and-drop, palette clicks, and form submissions.
2. **The AI Assistant**: Exposed as native *Function Calling* tools with JSON Schema definitions.
3. **Macros and Automation Scripts**: Composable, serializable, and replayable operations.

The rules of the network are declared on the schemas of the module and enforced by the engine, so a body stays thin, and each action executes inside an atomic, undoable transaction.

The package exports them as `ACTIONS`. Each has a body `run(params, context)`, the form of an action of `@scfloworg/actions`, and names the schemas of the module by their qualified name, such as `scflow.actor`. The manifest `module.yaml` declares each of them with its `id`, `title`, `description`, `kind`, `destructive`, `writes` and `parameters`, so a tool knows them without running code; a test checks that the declarations and `ACTIONS` agree, so adding or changing an action changes both. An environment runs them with `dataset.run(id, params)`.

---

## 1. Principles & Conventions

- **Identifiers**: `scflow/<action_name>` (lowercase with underscores).
- **Flexible Reference Resolution (ID or Name)**: To streamline AI calling and human scripting, a reference to an entity that has a `display_name` (actor, actor type, scope, location, item, item type, transformation, transformation type, conversion) accepts either its id or its display name. The id is tried first; otherwise the name must match exactly the `display_name` of one entity, in any language. No match is an error, and several matches are an error that lists the candidate ids. These references are parameters with the keyword `ref`, resolved by the registry before the body runs: a value that matches no instance or several is refused with `invalid_parameters`. An instance that has no name, such as an `item_at_actor`, can only be given by its id.
- **Atomic Transactions**: An action either succeeds completely or rolls back without leaving partial mutations in the model dataset. The action opens no transaction itself: the host runs it inside one.
- **Multilingual Support**: Text fields (`display_name`, `description`) accept either a plain string or a localized map `Record<string, string>`. An action receives no active language, so a plain string `s` is stored as `{ en: s }`.
- **Parameter validation**: The registry checks `parameters` against their JSON Schema before the body runs and refuses a breach with `invalid_parameters`, so a body validates nothing by hand.
- **CRUD parameters**: An action that takes the place of a CRUD operation of a schema, named by the `crud` of that schema, follows the CRUD parameters of the [meta-model](../../core/docs/spec/meta-model.md#action): a create takes the property names, an update takes `id` and the property names, and a delete takes `id` and `cascade`. A create takes every property of its schema, `tags` included.
- **Write limit**: Each action declares the schemas it writes in `writes`; a write outside them is refused with `write_not_declared`.
- **Read actions**: An action that only queries declares `kind: "read"`. The host runs it outside any undo transaction, so it writes nothing. The other actions are mutations (`kind: "action"`, the default).

### Rules

The [network rules](spec/implementation.md#network-rules) are declared on the schemas. The engine checks them at the end of the transaction of an action, and a breach refuses the whole action with `rule_violation`, whose details give `rule`, `schema` and `key`. A change of any instance that a rule reads is covered: changing the type of an actor or of an item is refused when an item it holds or carries no longer fits. A rule only refuses, so the actions below still write what a rule requires, such as the holdings of the two ends of a flow.

### Deletion and cascade

Every delete action, `scflow/remove_note` and `scflow/release_held_item` included, takes `id` and `cascade` (boolean, default `false`). `scflow/delete_flow` and `scflow/remove_note` accept `cascade` for consistency and it changes nothing. With `cascade: true`, `scflow/release_held_item` deletes the transformation lines that use the record. Without `cascade`, the action throws an error that counts the dependents and deletes nothing. With it, the action deletes the dependents first, in dependency order (transformation lines, conversions, held items, transformations, flows, actors from the deepest child to the root, items), then the target, so the engine never meets a restricted reference.

The notes of an entity are owned by it: deleting an entity deletes its notes, whatever `cascade` says, and a delete action never lists them as dependents. A deletion therefore removes the notes of the target and of every dependent it deletes.

---

## 2. Actions Catalog

### 2.1. Actors & Organization

#### `scflow/create_actor`
Creates an actor in the network.
- **Parameters**:
  - `display_name` *(string | Record<string, string>, required)*: Display name.
  - `type` *(string, required)*: ID or name of the `actor_type`.
  - `scope` *(string, optional)*: ID or name of the containing scope. When omitted, inherits the type's `default_scope`.
  - `location` *(string, optional)*: ID or name of the location of the actor. When omitted, the actor has no location.
  - `parent_actor` *(string, optional)*: ID or name of the parent container actor (for nested actors / hierarchy).
  - `description` *(string | Record<string, string>, optional)*: Markdown description.
  - `tags` *(string[], optional)*: Associated tag list.
- **Returns**: The created actor `{ id, display_name, type, scope?, location?, parent_actor? }`.

#### `scflow/update_actor`
Updates an existing actor's properties.
- **Parameters**:
  - `id` *(string, required)*: ID or name of the actor to update.
  - `display_name` *(string | Record<string, string>, optional)*.
  - `description` *(string | Record<string, string>, optional)*: New Markdown description.
  - `type` *(string, optional)*: ID or name of the new `actor_type`.
  - `scope` *(string | null, optional)*: ID or name of the new scope (or `null` to detach).
  - `location` *(string | null, optional)*: ID or name of the new location (or `null` to remove it).
  - `parent_actor` *(string | null, optional)*: ID or name of the new parent container (or `null` to move to root).
  - `tags` *(string[], optional)*.
- **Behavior**: Only the parameters that are given change the actor, and at least one must be given. A change of type or of parent that breaks a rule on the held items, the flows or the parent of the actor is refused with `rule_violation`. For `display_name` and `description`, each given language replaces the entry of the same language and the other languages are kept. An actor cannot become its own parent, directly or through its descendants: the `acyclic` rule, reported as `parent_actor`, refuses it. The package ships no action on locations yet, so a location is created with a command and referenced here by id or name.
- **Returns**: The updated actor `{ id, display_name, type, scope?, location?, parent_actor? }`.

#### `scflow/delete_actor`
Deletes an actor while enforcing referential integrity.
- **Parameters**:
  - `id` *(string, required)*: ID or name of the actor.
  - `cascade` *(boolean, optional, default `false`)*: When `true`, deletes the dependents listed below with the actor. When `false` and any of them exists, deletion is refused.
- **Behavior**: The dependents of an actor are its child actors (recursively, through `parent_actor`), the flows whose source or destination is the actor or one of its descendants, the items held there with the transformation lines that use them, the transformations owned there with their lines, and the conversions owned there. With `cascade: true` all of them are deleted, then the actor, with the notes of every deleted entity (see [Deletion and cascade](#deletion-and-cascade)). With `cascade: false` the action throws an error that counts the child actors, flows, held items, transformations and conversions, and deletes nothing.
- **Returns**: The id of the deleted actor `{ id }`.

#### `scflow/delete_actor_type`
Deletes an actor type.
- **Parameters**:
  - `id` *(string, required)*: ID or name of the actor type.
  - `cascade` *(boolean, optional, default `false`)*: When `true`, deletes the actors of this type first.
- **Behavior**: With `cascade: true`, every actor of the type is deleted with the cascade of `scflow/delete_actor`, so their descendants of other types go too. With `cascade: false` the action throws when an actor has this type.
- **Returns**: The id of the deleted type `{ id }`.

#### `scflow/delete_scope`
Deletes a scope.
- **Parameters**:
  - `id` *(string, required)*: ID or name of the scope.
  - `cascade` *(boolean, optional, default `false`)*: When `true`, deletes the actors assigned to the scope first.
- **Behavior**: With `cascade: true`, every actor of the scope is deleted with the cascade of `scflow/delete_actor`, so their descendants outside the scope go too. With `cascade: false` the action throws when an actor is assigned to the scope. In both modes, the `default_scope` of an actor type that names the scope is cleared.
- **Returns**: The id of the deleted scope `{ id }`.

#### `scflow/create_actor_type`
Registers a new actor type with its allowed flow domains.
- **Parameters**:
  - `display_name` *(string | Record<string, string>, required)*.
  - `domains` *(flow_domain[], optional, default `["physical"]`)*: Subset of `[physical, information, financial, service]`.
  - `default_scope` *(string, optional)*: ID or name of the default scope assigned to newly created actors of this type.
  - `description` *(string | Record<string, string>, optional)*.
- **Returns**: The created actor type `{ id, display_name, domains, default_scope? }`.

#### `scflow/create_scope`
Creates a scope/lane boundary (e.g., SOURCE, MAKE, DELIVER, or geographic regions).
- **Parameters**:
  - `display_name` *(string | Record<string, string>, required)*.
  - `description` *(string | Record<string, string>, optional)*.
- **Returns**: The created scope `{ id, display_name }`.

---

### 2.2. Flows & Connectivity

#### `scflow/create_flow`
Creates one flow between two actors, one-way from source to destination unless `bidirectional` is set.
- **Behavior**: A flow has no domain, so the action does not check the domains of the two actors; an interface that wants to refuse a connection between actors without a common domain asks `getCommonFlowDomains` first. Flows that already link the two actors are neither reused nor reported: each call creates a new flow. A flow carries at most one item. A flow between an actor and one of its child actors, in either direction, is a transport inside the actor and must carry an item (rule `internal_flow_item`). When `item` is given, its domain must be among the domains of the actor type of the source and of the destination (rule `carried_item_domain`), and the action creates the `item_at_actor` that the source and the destination lack (rule `flow_ends_hold_item`), as `scflow/hold_item` does.
- **Parameters**:
  - `source` *(string, required)*: ID or name of the source actor.
  - `destination` *(string, required)*: ID or name of the destination actor.
  - `item` *(string, optional)*: ID or name of the item the flow carries; required between an actor and its child.
  - `bidirectional` *(boolean, optional)*: Whether the flow carries items in both directions; `false` when omitted.
  - `display_name` *(string | Record<string, string>, optional)*: Display name of the flow.
  - `description` *(string | Record<string, string>, optional)*: Markdown description.
  - `tags` *(string[], optional)*: Tags of the flow; duplicates count once.
- **Returns**: The created flow `{ id, display_name?, source, destination, item?, bidirectional }`; `display_name` is absent when the flow has no name, and `item` when it carries none.

#### `scflow/update_flow`
Changes the name, the bidirectional flag, the description or the tags of a flow.
- **Behavior**: Only the given properties change. A call that gives none of `display_name`, `bidirectional`, `description` and `tags` is an error. `name` and `description` follow the language rule of `scflow/update_actor`: each given language replaces the same language and the others are kept; `null` removes every language of the name. `tags` replaces the whole list. The source and the destination of a flow never change: to reconnect, delete the flow and call `scflow/create_flow` again.
- **Parameters**:
  - `id` *(string, required)*: ID or name of the flow.
  - `display_name` *(string | Record<string, string> | null, optional)*: New display name; `null` removes it.
  - `bidirectional` *(boolean, optional)*: Whether the flow carries items in both directions.
  - `description` *(string | Record<string, string>, optional)*: New Markdown description.
  - `tags` *(string[], optional)*: New tags; they replace the current ones.
- **Returns**: The updated flow `{ id, display_name?, source, destination, item?, bidirectional }`; `display_name` is absent when the flow has no name, and `item` when it carries none.

#### `scflow/set_flow_item`
Sets the item carried by a flow that carries none.
- **Behavior**: The item of a flow never changes and is never removed: it is `set_once`, so another item is refused with `constraint_violation`, and the given one again changes nothing. The domain of the item must be among the domains of the actor type of the source and of the destination (rule `carried_item_domain`). The action creates the `item_at_actor` that the source and the destination lack, so that both hold the item (rule `flow_ends_hold_item`).
- **Parameters**:
  - `id` *(string, required)*: ID or name of the flow.
  - `item` *(string, required)*: ID or name of the item.
- **Returns**: The flow `{ id, display_name?, source, destination, item, bidirectional }`.

#### `scflow/delete_flow`
Removes a flow. The item of the flow and the items held by its source and destination are kept.
- **Parameters**:
  - `id` *(string, required)*: ID or name of the flow.
- **Returns**: The id of the deleted flow `{ id }`.

---

### 2.3. Items & Inventory

#### `scflow/create_item_type`
Defines an item category bound to a single domain.
- **Parameters**:
  - `display_name` *(string | Record<string, string>, required)*.
  - `domain` *(flow_domain, required)*: One of `physical`, `information`, `financial`, `service`.
  - `description` *(string | Record<string, string>, optional)*.
- **Returns**: The created item type `{ id, display_name, domain }`.

#### `scflow/create_item`
Creates an item family/reference in the model.
- **Parameters**:
  - `display_name` *(string | Record<string, string>, required)*.
  - `type` *(string, required)*: ID or name of the `item_type`.
  - `tags` *(string[], optional)*.
- **Returns**: The created item `{ id, display_name, type }`.

#### `scflow/update_item`
Changes the name, the description or the type of an item.
- **Parameters**:
  - `id` *(string, required)*: ID or name of the item to update.
  - `display_name` *(string | Record<string, string>, optional)*.
  - `description` *(string | Record<string, string>, optional)*: New Markdown description.
  - `type` *(string, optional)*: ID or name of the new `item_type`.
- **Behavior**: Only the given properties change, and at least one must be given. For `display_name` and `description`, each given language replaces the entry of the same language and the other languages are kept. A change of type that breaks a rule on the held records of the item or the flows that carry it is refused with `rule_violation`.
- **Returns**: The updated item `{ id, display_name, type }`.

#### `scflow/hold_item`
Associates an item with an actor (`item_at_actor`: inventory, presence, or buffer).
- **Behavior**: The domain of the item (the domain of its type) must be among the domains of the actor, otherwise the action fails. An actor holds a given item at most once: when the actor already holds it, the existing record is returned and nothing is created.
- **Parameters**:
  - `actor` *(string, required)*: ID or name of the actor.
  - `item` *(string, required)*: ID or name of the item.
- **Returns**: The created or existing `item_at_actor` record `{ id, actor, item }`.

#### `scflow/release_held_item`
Removes an item from an actor (verifies that no active transformation uses it).
- **Behavior**: Refused while a line of a transformation references the record; the error gives the number of lines.
- **Parameters**:
  - `id` *(string, required)*: ID of the `item_at_actor` record.
- **Returns**: The id of the removed record `{ id }`.

#### `scflow/delete_item`
Deletes an item.
- **Parameters**:
  - `id` *(string, required)*: ID or name of the item.
  - `cascade` *(boolean, optional, default `false`)*: When `true`, deletes the records that reference the item first.
- **Behavior**: The dependents of an item are the `item_at_actor` records that hold it, the flows that carry it, the conversions whose `from_item` or `to_item` is the item, and the transformation lines that use its held records. With `cascade: true` all of them are deleted, then the item, with the notes of every deleted entity. With `cascade: false` the action throws an error that counts the held records, the flows and the conversions, and deletes nothing.
- **Returns**: The id of the deleted item `{ id }`.

#### `scflow/delete_item_type`
Deletes an item type.
- **Parameters**:
  - `id` *(string, required)*: ID or name of the item type.
  - `cascade` *(boolean, optional, default `false`)*: When `true`, deletes the items of this type first.
- **Behavior**: With `cascade: true`, every item of the type is deleted with the cascade of `scflow/delete_item`. With `cascade: false` the action throws when an item has this type.
- **Returns**: The id of the deleted type `{ id }`.

---

### 2.4. Transformations & Processes

#### `scflow/create_transformation_type`
Defines an operation type (e.g., Assembly, Machining, Packaging, QA inspection).
- **Parameters**:
  - `display_name` *(string | Record<string, string>, required)*.
  - `description` *(string | Record<string, string>, optional)*.
- **Returns**: The created transformation type `{ id, display_name }`.

#### `scflow/create_transformation`
Instantiates a transformation process inside an actor.
- **Behavior**: A transformation always has a display name. When `display_name` is omitted, the transformation takes the display name of its type. Transformation names are not unique, so a later reference by name that matches several transformations fails and lists their ids.
- **Parameters**:
  - `actor` *(string, required)*: ID or name of the actor executing the transformation.
  - `type` *(string, required)*: ID or name of the transformation type.
  - `display_name` *(string | Record<string, string>, optional)*.
- **Returns**: The created transformation `{ id, display_name, type, actor }`.

#### `scflow/connect_transformation_line`
Connects an actor's held item to a transformation as an input or output.
- **Behavior**: The held item must be held by the actor of the transformation, otherwise the action fails. When the transformation already has a line with the same held item and the same role, that line is returned and nothing is created. The same held item can be consumed and produced by one transformation.
- **Parameters**:
  - `transformation` *(string, required)*: ID or name of the transformation.
  - `held_item` *(string, required)*: ID of the `item_at_actor` record.
  - `role` *(transformation_role, required)*: `consumed` or `produced`.
- **Returns**: The created or existing line `{ id, transformation, held_item, role }`.

#### `scflow/define_process` *(Composite Macro)*
High-level compound action: instantiates the transformation at the actor, ensures consumed and produced items are held at the actor (creating `item_at_actor` links if missing), and attaches all transformation lines in a single step.
- **Behavior**: The actor, the type and every item are resolved before anything is written, and an item outside the domains of the actor refuses the whole action (rule `held_item_domain`). The transformation takes the display name of its type. An item listed twice in one list counts once; an item listed in both lists is consumed and produced.
- **Parameters**:
  - `actor` *(string, required)*: ID or name of the actor.
  - `transformation_type` *(string, required)*: ID or name of the transformation type.
  - `consumed_items` *(string[], optional)*: IDs or names of the items consumed.
  - `produced_items` *(string[], optional)*: IDs or names of the items produced.
- **Returns**: `{ transformation, lines }`: the created transformation as in `scflow/create_transformation`, and its lines `[{ id, transformation, held_item, role }]`, consumed first.

#### `scflow/delete_transformation`
Deletes a transformation.
- **Parameters**:
  - `id` *(string, required)*: ID or name of the transformation.
  - `cascade` *(boolean, optional, default `false`)*: Accepted for consistency with the other delete actions; it has no effect.
- **Behavior**: The lines of the transformation and the notes of both are always deleted with it. The held items that the lines used are kept.
- **Returns**: The id of the deleted transformation `{ id }`.

#### `scflow/delete_transformation_type`
Deletes a transformation type.
- **Parameters**:
  - `id` *(string, required)*: ID or name of the transformation type.
  - `cascade` *(boolean, optional, default `false`)*: When `true`, deletes the transformations of this type first.
- **Behavior**: With `cascade: true`, every transformation of the type is deleted as by `scflow/delete_transformation`. With `cascade: false` the action throws when a transformation has this type.
- **Returns**: The id of the deleted type `{ id }`.

---

### 2.5. Conversions

A conversion turns one item into another item at an actor, the way a flow moves an item from one actor to another. It is owned by its actor, has an optional name, an optional description and tags, and references two items of the same flow domain, the item that is converted (`from_item`) and the item that results (`to_item`). The actor and the two items never change after creation.

#### `scflow/create_conversion`
Creates a conversion at an actor.
- **Behavior**: The domain of `to_item` must be the domain of `from_item`, otherwise the action is refused and creates nothing (rule `conversion_item_domain`). `from_item` and `to_item` may be the same item. The domain of the items is not compared with the domains of the actor, and a conversion has no uniqueness rule.
- **Parameters**:
  - `actor` *(string, required)*: ID or name of the actor where the conversion takes place.
  - `from_item` *(string, required)*: ID or name of the item that is converted.
  - `to_item` *(string, required)*: ID or name of the item that results.
  - `display_name` *(string | Record<string, string>, optional)*: Display name of the conversion.
  - `description` *(string | Record<string, string>, optional)*: Markdown description.
  - `tags` *(string[], optional)*: Tags of the conversion; duplicates count once.
- **Returns**: The created conversion `{ id, display_name?, actor, from_item, to_item }`; `display_name` is absent when the conversion has no name.

#### `scflow/update_conversion`
Changes the name, the description or the tags of a conversion.
- **Parameters**:
  - `id` *(string, required)*: ID or name of the conversion.
  - `display_name` *(string | Record<string, string> | null, optional)*: New display name.
  - `description` *(string | Record<string, string> | null, optional)*: New Markdown description.
  - `tags` *(string[], optional)*: New tags; they replace the current ones.
- **Behavior**: Only the given properties change, and at least one must be given. For `display_name` and `description`, each given language replaces the entry of the same language and the other languages are kept; `null` removes every language. `tags` replaces the whole list. The actor and the two items of a conversion never change: to change them, delete the conversion and create another.
- **Returns**: The updated conversion, as in `scflow/create_conversion`.

#### `scflow/delete_conversion`
Deletes a conversion.
- **Parameters**:
  - `id` *(string, required)*: ID or name of the conversion.
  - `cascade` *(boolean, optional, default `false`)*: Accepted for consistency with the other delete actions; it has no effect.
- **Behavior**: The notes of the conversion are always deleted with it. The actor and the items are kept.
- **Returns**: The id of the deleted conversion `{ id }`.

---

### 2.6. Notes

A note is a free-form annotation of any entity of the model, in one or more languages. Every entity (actor, flow, item, scope, type, item at actor, transformation, transformation line, conversion) is annotable, and a note is deleted with the entity it annotates. A note and an entity are referenced by their id only.

#### `scflow/add_note`
Adds a note to an entity.
- **Parameters**:
  - `annotated` *(string, required)*: Id of the annotated entity, whatever its schema.
  - `content` *(string | Record<string, string>, required)*: Markdown text. A plain string is stored as `{ en: s }`.
- **Behavior**: The entity is found among all the entities, by its id or by a name that designates one instance; no match is refused with `invalid_parameters`. A note has no uniqueness rule: the same text can be added twice.
- **Returns**: The created note `{ id, entity, content }`.

#### `scflow/update_note`
Changes the content of a note.
- **Parameters**:
  - `id` *(string, required)*: Id of the note.
  - `content` *(string | Record<string, string>, required)*: Each given language replaces the entry of the same language; the other languages are kept.
- **Behavior**: The note stays on its entity.
- **Returns**: The updated note `{ id, entity, content }`.

#### `scflow/remove_note`
Deletes a note.
- **Parameters**:
  - `id` *(string, required)*: Id of the note.
- **Returns**: The id of the deleted note `{ id }`.

#### `scflow/find_notes` *(`kind: "read"`)*
Lists the notes of an entity.
- **Parameters**:
  - `entity` *(string, required)*: Id of the entity, whatever its schema.
- **Behavior**: It writes nothing and runs outside any undo transaction. An entity without a note gives an empty list; an unknown id is an error.
- **Returns**: The notes `[{ id, entity, content }]`.

---

### 2.7. Tags

Every entity carries a list of tags (`tags`), empty by default, whose entries are distinct. `scflow/create_actor`, `scflow/update_actor`, `scflow/create_item`, `scflow/create_conversion` and `scflow/update_conversion` set the whole list; the two actions below change it one tag at a time, on an entity of any kind (a scope, a type, a transformation or an item at actor included).

#### `scflow/add_tags`
Appends tags to an entity without touching its existing tags.
- **Parameters**:
  - `entity` *(string, required)*: Id of the entity, whatever its schema.
  - `tags` *(string[], required)*: Tags to add; at least one, each a non-empty string.
- **Behavior**: The entity is found as in `scflow/add_note`. Duplicates in `tags` count once. A tag that the entity already carries is skipped, so the action is idempotent; the new tags follow the existing ones in the order given.
- **Returns**: `{ id, tags }`: the entity and its tags after the change.

#### `scflow/remove_tags`
Removes the given tags from an entity.
- **Parameters**:
  - `entity` *(string, required)*: As in `scflow/add_tags`.
  - `tags` *(string[], required)*: Tags to remove; at least one, each a non-empty string.
- **Behavior**: The entity is found as in `scflow/add_tags`. Every given tag is removed and the other tags keep their order. A tag that the entity does not carry is ignored, so the action is idempotent.
- **Returns**: `{ id, tags }`: the entity and its tags after the change.

---

### 2.8. Inspection

#### `scflow/inspect_delete_impact` *(`kind: "read"`)*
Reports what deleting entities with `cascade: true` would remove, so that a UI can fill a confirmation dialog and an assistant can state the consequences before it deletes.
- **Parameters**:
  - `targets` *(`{ schema, ref }[]`, required, at least one)*: The entities to delete. `schema` is one of `actor`, `actor_type`, `scope`, `item`, `item_type`, `flow`, `transformation`, `transformation_type`, `conversion`, `item_at_actor`. `ref` is the ID or the name of the entity, and the ID only for a `flow`, an `item_at_actor` and a conversion that has no name.
- **Behavior**: It writes nothing and runs outside any undo transaction. It applies the cascade rules of the delete actions (see [Deletion and cascade](#deletion-and-cascade)): a `actor_type` or a `scope` target reaches its actors, an `item_type` its items, a `transformation_type` its transformations; an `actor` or an `item` target reaches the conversions that the actor owns or that reference the item. An entity reached from several targets is listed and counted once, and an entity that is itself a target is listed in `targets`, not in `cascaded`. A target given twice counts once. An unknown reference is an error.
- **Returns**: `{ targets, cascaded, counts, hasSideEffects }`:
  - `targets`: `[{ schema, id, label }]`, the resolved targets. The label of a flow is `source → destination`, and the label of a conversion without a name is `from item → to item`.
  - `cascaded`: what is deleted besides the targets: `actors` `[{ id, label, isChild? }]` (`isChild` is set when the parent actor is deleted too), `flows` `[{ id, label }]`, `items` `[{ id, label }]`, `heldItems` `[{ id, actorName, itemName }]`, `transformations` `[{ id, label }]`, `transformationLines` (number), `conversions` `[{ id, label }]` and `notes` (number, the notes of the targets and of every cascaded entity).
  - `counts`: `{ actors, flows, items, heldItems, transformations, transformationLines, conversions, notes, total }`, the sizes of the lists above and their sum.
  - `hasSideEffects`: `true` when `counts.total` is above zero.

```json
{ "targets": [{ "schema": "actor", "ref": "Campus" }] }
```
