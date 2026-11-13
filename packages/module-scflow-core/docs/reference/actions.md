<!-- Generated from module.yaml by the build of the package. Do not edit. -->

# Supply chain flow: actions

### `scflow/create_actor`

Create an actor. Creates an actor of a given type in the network, optionally in a scope, at a location and inside a parent actor, and returns it. The scope defaults to the default scope of the type; the location has no default.

Flags: writes `actor`.

Parameters:
- `display_name` (text or map language → text, required): Display name of the actor, a string or a map of language to string.
- `type` (id or name of actor_type, required): Id or name of the actor type.
- `scope` (id or name of scope): Id or name of the containing scope; the default scope of the type when omitted.
- `location` (id or name of location): Id or name of the location of the actor; none when omitted.
- `parent_actor` (id or name of actor): Id or name of the parent actor, to nest the actor in a hierarchy.
- `description` (text or map language → text): Markdown description of the actor.
- `tags` (list of string): Tags of the actor.

Examples:

```
scflow/create_actor {"display_name":"text","type":"<actor_type>"}
scflow/create_actor {"display_name":"text","type":"<actor_type>","scope":"<scope>","location":"<location>","parent_actor":"<actor>","description":"text","tags":["text"]}
```

### `scflow/update_actor`

Update an actor. Changes the name, description, type, scope, location, parent or tags of an actor and returns it. Only the given properties change; scope, location and parent_actor accept null to clear the relation. A change that breaks a rule on the held items, the flows or the parent of the actor is refused.

Flags: writes `actor`.

Parameters:
- `id` (id or name of actor, required): Id or name of the actor to update.
- `display_name` (text or map language → text): New display name; each given language replaces the same language, the others are kept.
- `description` (text or map language → text): New Markdown description; same language rule as name.
- `type` (id or name of actor_type): Id or name of the new actor type.
- `scope` (id or name of scope): Id or name of the new scope, or null to detach the actor from its scope.
- `location` (id or name of location): Id or name of the new location, or null to remove the location of the actor.
- `parent_actor` (id or name of actor): Id or name of the new parent actor, or null to move the actor to the root.
- `tags` (list of string): New tags; they replace the current ones.

Examples:

```
scflow/update_actor {"id":"<actor>"}
scflow/update_actor {"id":"<actor>","display_name":"text","description":"text","type":"<actor_type>","scope":"<scope>","location":"<location>","parent_actor":"<actor>","tags":["text"]}
```

### `scflow/delete_actor`

Delete an actor. Deletes an actor. It is refused while child actors, flows, held items, transformations or conversions reference the actor, unless cascade is true, which deletes the child actors recursively, the flows incident to the actor and its descendants, the items they hold, their transformations and conversions and the notes of every deleted entity.

Flags: destructive; writes `actor`, `flow`, `item_at_actor`, `transformation`, `transformation_line`, `conversion`.

Parameters:
- `id` (id or name of actor, required): Id or name of the actor to delete.
- `cascade` (boolean): When true, also deletes the descendant actors, the incident flows, the held items, the transformations, the conversions and the notes.

Examples:

```
scflow/delete_actor {"id":"<actor>"}
scflow/delete_actor {"id":"<actor>","cascade":true}
```

### `scflow/delete_actor_type`

Delete an actor type. Deletes an actor type. It is refused while actors have this type, unless cascade is true, which deletes those actors first, each with the cascade of scflow/delete_actor.

Flags: destructive; writes `actor`, `flow`, `item_at_actor`, `transformation`, `transformation_line`, `conversion`, `actor_type`.

Parameters:
- `id` (id or name of actor_type, required): Id or name of the actor type to delete.
- `cascade` (boolean): When true, also deletes the actors of this type with their descendants, flows, held items, transformations and notes.

Examples:

```
scflow/delete_actor_type {"id":"<actor_type>"}
scflow/delete_actor_type {"id":"<actor_type>","cascade":true}
```

### `scflow/delete_scope`

Delete a scope. Deletes a scope. It is refused while actors are assigned to it, unless cascade is true, which deletes those actors first, each with the cascade of scflow/delete_actor. The default scope of an actor type that names the scope is cleared.

Flags: destructive; writes `actor`, `flow`, `item_at_actor`, `transformation`, `transformation_line`, `conversion`, `scope`, `actor_type`.

Parameters:
- `id` (id or name of scope, required): Id or name of the scope to delete.
- `cascade` (boolean): When true, also deletes the actors of this scope with their descendants, flows, held items, transformations and notes.

Examples:

```
scflow/delete_scope {"id":"<scope>"}
scflow/delete_scope {"id":"<scope>","cascade":true}
```

### `scflow/create_actor_type`

Create an actor type. Creates an actor type with the flow domains its actors can exchange, and an optional default scope, and returns it.

Flags: writes `actor_type`.

Parameters:
- `display_name` (text or map language → text, required): Display name of the actor type, a string or a map of language to string.
- `domains` (list of physical | information | financial | service): Flow domains of the type; physical when omitted.
- `default_scope` (id or name of scope): Id or name of the scope given to the actors of this type that name no scope.
- `description` (text or map language → text): Markdown description of the actor type.
- `tags` (list of string): Tags of the actor type.

Examples:

```
scflow/create_actor_type {"display_name":"text"}
scflow/create_actor_type {"display_name":"text","domains":["physical"],"default_scope":"<scope>","description":"text","tags":["text"]}
```

### `scflow/create_scope`

Create a scope. Creates a scope, a lane that groups actors (for example SOURCE, MAKE, DELIVER or a region), and returns it.

Flags: writes `scope`.

Parameters:
- `display_name` (text or map language → text, required): Display name of the scope, a string or a map of language to string.
- `description` (text or map language → text): Markdown description of the scope.
- `tags` (list of string): Tags of the scope.

Examples:

```
scflow/create_scope {"display_name":"text"}
scflow/create_scope {"display_name":"text","description":"text","tags":["text"]}
```

### `scflow/create_flow`

Create a flow. Creates a flow from a source actor to a destination actor and returns it. Set bidirectional to true so that the flow carries items in both directions; it is one-way otherwise. Give display_name to name the flow; it has no name otherwise. A flow carries at most one item, given by item. A flow between an actor and one of its child actors, in either direction, must carry an item, otherwise the action fails. The domain of the item must be among the domains of both actors, and the actors that do not hold the item yet hold it afterwards.

Flags: writes `flow`, `item_at_actor`.

Parameters:
- `source` (id or name of actor, required): Id or name of the actor the flow starts from.
- `destination` (id or name of actor, required): Id or name of the actor the flow arrives at.
- `item` (id or name of item): Id or name of the item the flow carries; required between an actor and its child.
- `bidirectional` (boolean): Whether the flow carries items in both directions; false when omitted.
- `display_name` (text or map language → text): Display name of the flow, a string or a map of language to string; the flow has no name when omitted.
- `description` (text or map language → text): Markdown description of the flow.
- `tags` (list of string): Tags of the flow.

Examples:

```
scflow/create_flow {"source":"<actor>","destination":"<actor>"}
scflow/create_flow {"source":"<actor>","destination":"<actor>","item":"<item>","bidirectional":true,"display_name":"text","description":"text","tags":["text"]}
```

### `scflow/update_flow`

Update a flow. Changes the name, the bidirectional flag, the description or the tags of a flow and returns it. Only the given properties change; null removes the name. The source and the destination of a flow never change: delete the flow and create it again.

Flags: writes `flow`.

Parameters:
- `id` (id or name of flow, required): Id of the flow to update.
- `display_name` (text or map language → text): New display name; each given language replaces the same language, the others are kept. null removes the name.
- `bidirectional` (boolean): Whether the flow carries items in both directions.
- `description` (text or map language → text): New Markdown description; each given language replaces the same language, the others are kept.
- `tags` (list of string): New tags; they replace the current ones.

Examples:

```
scflow/update_flow {"id":"<flow>"}
scflow/update_flow {"id":"<flow>","display_name":"text","bidirectional":true,"description":"text","tags":["text"]}
```

### `scflow/set_flow_item`

Set the item of a flow. Sets the item carried by a flow that carries none, and returns the flow. The item of a flow never changes and is never removed: the action fails when the flow carries another item, and changes nothing when it already carries this one. The domain of the item must be among the domains of both the source and the destination, and the actors that do not hold the item yet hold it afterwards.

Flags: writes `flow`, `item_at_actor`.

Parameters:
- `id` (id or name of flow, required): Id of the flow.
- `item` (id or name of item, required): Id or name of the item.

Examples:

```
scflow/set_flow_item {"id":"<flow>","item":"<item>"}
```

### `scflow/delete_flow`

Delete a flow. Deletes a flow and returns its id. The items held by its ends are kept. The cascade parameter is accepted for consistency with the other delete actions and changes nothing.

Flags: destructive; writes `flow`.

Parameters:
- `id` (id or name of flow, required): Id of the flow to delete.
- `cascade` (boolean): Has no effect: nothing depends on a flow but its notes, which are always deleted with it.

Examples:

```
scflow/delete_flow {"id":"<flow>"}
scflow/delete_flow {"id":"<flow>","cascade":true}
```

### `scflow/create_item_type`

Create an item type. Creates an item type, a category of items bound to one flow domain (physical, information, financial or service), and returns it.

Flags: writes `item_type`.

Parameters:
- `display_name` (text or map language → text, required): Display name of the item type, a string or a map of language to string.
- `domain` (physical | information | financial | service, required): The flow domain of the items of this type.
- `description` (text or map language → text): Markdown description of the item type.
- `tags` (list of string): Tags of the item type.

Examples:

```
scflow/create_item_type {"display_name":"text","domain":"physical"}
scflow/create_item_type {"display_name":"text","domain":"physical","description":"text","tags":["text"]}
```

### `scflow/create_item`

Create an item. Creates an item, a family of things the network moves and holds, of a given item type, and returns it.

Flags: writes `item`.

Parameters:
- `display_name` (text or map language → text, required): Display name of the item, a string or a map of language to string.
- `type` (id or name of item_type, required): Id or name of the item type.
- `description` (text or map language → text): Markdown description of the item.
- `tags` (list of string): Tags of the item.

Examples:

```
scflow/create_item {"display_name":"text","type":"<item_type>"}
scflow/create_item {"display_name":"text","type":"<item_type>","description":"text","tags":["text"]}
```

### `scflow/update_item`

Update an item. Changes the name, description or type of an item and returns it. Only the given properties change. A change of type that breaks a rule on the held records of the item or the flows that carry it is refused.

Flags: writes `item`.

Parameters:
- `id` (id or name of item, required): Id or name of the item to update.
- `display_name` (text or map language → text): New display name; each given language replaces the same language, the others are kept.
- `description` (text or map language → text): New Markdown description; same language rule as name.
- `type` (id or name of item_type): Id or name of the new item type.
- `tags` (list of string): New tags; they replace the current ones.

Examples:

```
scflow/update_item {"id":"<item>"}
scflow/update_item {"id":"<item>","display_name":"text","description":"text","type":"<item_type>","tags":["text"]}
```

### `scflow/hold_item`

Hold an item at an actor. Makes an actor hold an item (inventory, queue, cash or backlog) and returns the record. The domain of the item must be among the domains of the actor. When the actor already holds the item, the existing record is returned.

Flags: writes `item_at_actor`.

Parameters:
- `actor` (id or name of actor, required): Id or name of the actor.
- `item` (id or name of item, required): Id or name of the item.
- `tags` (list of string): Tags of the record, when the action creates it.

Examples:

```
scflow/hold_item {"actor":"<actor>","item":"<item>"}
scflow/hold_item {"actor":"<actor>","item":"<item>","tags":["text"]}
```

### `scflow/release_held_item`

Release a held item. Removes an item from the actor that holds it, and returns the id of the removed record. It is refused while a transformation line uses the record, unless cascade is true, which deletes those lines first. Give the id of the record returned by hold_item.

Flags: destructive; writes `item_at_actor`, `transformation_line`.

Parameters:
- `id` (id or name of item_at_actor, required): Id of the item-at-actor record to remove.
- `cascade` (boolean): When true, also deletes the transformation lines that use the record.

Examples:

```
scflow/release_held_item {"id":"<item_at_actor>"}
scflow/release_held_item {"id":"<item_at_actor>","cascade":true}
```

### `scflow/delete_item`

Delete an item. Deletes an item. It is refused while actors hold it, flows carry it or conversions reference it, unless cascade is true, which deletes the held records, the flows that carry it and the conversions first, with the transformation lines that use the held records and the notes of every deleted entity.

Flags: destructive; writes `item`, `flow`, `item_at_actor`, `transformation_line`, `conversion`.

Parameters:
- `id` (id or name of item, required): Id or name of the item to delete.
- `cascade` (boolean): When true, also deletes the held records, the flows that carry the item, the conversions, the transformation lines and the notes.

Examples:

```
scflow/delete_item {"id":"<item>"}
scflow/delete_item {"id":"<item>","cascade":true}
```

### `scflow/delete_item_type`

Delete an item type. Deletes an item type. It is refused while items have this type, unless cascade is true, which deletes those items first, each with the cascade of scflow/delete_item.

Flags: destructive; writes `item`, `item_type`, `flow`, `item_at_actor`, `transformation_line`, `conversion`.

Parameters:
- `id` (id or name of item_type, required): Id or name of the item type to delete.
- `cascade` (boolean): When true, also deletes the items of this type with their held records, flows, lines and notes.

Examples:

```
scflow/delete_item_type {"id":"<item_type>"}
scflow/delete_item_type {"id":"<item_type>","cascade":true}
```

### `scflow/create_transformation_type`

Create a transformation type. Creates a transformation type, a kind of operation such as assembly, machining, packaging or inspection, and returns it.

Flags: writes `transformation_type`.

Parameters:
- `display_name` (text or map language → text, required): Display name of the transformation type, a string or a map of language to string.
- `description` (text or map language → text): Markdown description of the transformation type.
- `tags` (list of string): Tags of the transformation type.

Examples:

```
scflow/create_transformation_type {"display_name":"text"}
scflow/create_transformation_type {"display_name":"text","description":"text","tags":["text"]}
```

### `scflow/create_transformation`

Create a transformation. Creates a transformation of a given type inside an actor, with no line yet, and returns it. The transformation is named after its type when no name is given.

Flags: writes `transformation`.

Parameters:
- `actor` (id or name of actor, required): Id or name of the actor that executes the transformation.
- `type` (id or name of transformation_type, required): Id or name of the transformation type.
- `display_name` (text or map language → text): Display name of the transformation; the name of its type when omitted.
- `description` (text or map language → text): Markdown description of the transformation.
- `tags` (list of string): Tags of the transformation.

Examples:

```
scflow/create_transformation {"actor":"<actor>","type":"<transformation_type>"}
scflow/create_transformation {"actor":"<actor>","type":"<transformation_type>","display_name":"text","description":"text","tags":["text"]}
```

### `scflow/connect_transformation_line`

Connect a transformation line. Connects an item held by the actor of a transformation to that transformation, as an input (consumed) or an output (produced), and returns the line. When the same line exists, it is returned. Give the id of the held-item record.

Flags: writes `transformation_line`.

Parameters:
- `transformation` (id or name of transformation, required): Id or name of the transformation.
- `held_item` (id or name of item_at_actor, required): Id of the item-at-actor record, held by the actor of the transformation.
- `role` (consumed | produced, required): Whether the transformation consumes or produces the item.
- `tags` (list of string): Tags of the line, when the action creates it.

Examples:

```
scflow/connect_transformation_line {"transformation":"<transformation>","held_item":"<item_at_actor>","role":"consumed"}
scflow/connect_transformation_line {"transformation":"<transformation>","held_item":"<item_at_actor>","role":"consumed","tags":["text"]}
```

### `scflow/define_process`

Define a process. Creates a transformation of a given type at an actor, makes the actor hold the consumed and produced items that it does not hold yet, and attaches a line for each of them, in one step. Every item must be in a domain of the actor. Returns the transformation and its lines.

Flags: writes `transformation`, `item_at_actor`, `transformation_line`.

Parameters:
- `actor` (id or name of actor, required): Id or name of the actor.
- `transformation_type` (id or name of transformation_type, required): Id or name of the transformation type.
- `consumed_items` (list of id or name of item): Ids or names of the items consumed.
- `produced_items` (list of id or name of item): Ids or names of the items produced.

Examples:

```
scflow/define_process {"actor":"<actor>","transformation_type":"<transformation_type>"}
scflow/define_process {"actor":"<actor>","transformation_type":"<transformation_type>","consumed_items":["<item>"],"produced_items":["<item>"]}
```

### `scflow/delete_transformation`

Delete a transformation. Deletes a transformation with its lines and notes, and returns its id. The held items that its lines used are kept. The cascade parameter is accepted for consistency with the other delete actions and changes nothing.

Flags: destructive; writes `transformation`, `transformation_line`.

Parameters:
- `id` (id or name of transformation, required): Id or name of the transformation to delete.
- `cascade` (boolean): Has no effect: the lines and the notes of a transformation are always deleted with it.

Examples:

```
scflow/delete_transformation {"id":"<transformation>"}
scflow/delete_transformation {"id":"<transformation>","cascade":true}
```

### `scflow/delete_transformation_type`

Delete a transformation type. Deletes a transformation type. It is refused while transformations have this type, unless cascade is true, which deletes those transformations first, with their lines and notes.

Flags: destructive; writes `transformation`, `transformation_line`, `transformation_type`.

Parameters:
- `id` (id or name of transformation_type, required): Id or name of the transformation type to delete.
- `cascade` (boolean): When true, also deletes the transformations of this type with their lines and notes.

Examples:

```
scflow/delete_transformation_type {"id":"<transformation_type>"}
scflow/delete_transformation_type {"id":"<transformation_type>","cascade":true}
```

### `scflow/create_conversion`

Create a conversion. Creates a conversion, which turns one item into another item at an actor, and returns it. The two items must be in the same flow domain, and they cannot change afterwards. The name, the description and the tags are optional.

Flags: writes `conversion`.

Parameters:
- `actor` (id or name of actor, required): Id or name of the actor where the conversion takes place.
- `from_item` (id or name of item, required): Id or name of the item that is converted.
- `to_item` (id or name of item, required): Id or name of the item that results; it has the domain of from_item.
- `display_name` (text or map language → text): Display name of the conversion, a string or a map of language to string.
- `description` (text or map language → text): Markdown description of the conversion.
- `tags` (list of string): Tags of the conversion.

Examples:

```
scflow/create_conversion {"actor":"<actor>","from_item":"<item>","to_item":"<item>"}
scflow/create_conversion {"actor":"<actor>","from_item":"<item>","to_item":"<item>","display_name":"text","description":"text","tags":["text"]}
```

### `scflow/update_conversion`

Update a conversion. Changes the name, the description or the tags of a conversion and returns it. Only the given properties change; null clears a name or a description, and tags replaces the whole list. The actor and the two items of a conversion never change: to change them, delete the conversion and create another.

Flags: writes `conversion`.

Parameters:
- `id` (id or name of conversion, required): Id or name of the conversion to update.
- `display_name` (text or map language → text): New display name; each given language replaces the same language, the others are kept. null removes the name.
- `description` (text or map language → text): New Markdown description; same language rule as name. null removes the description.
- `tags` (list of string): New tags; they replace the current ones.

Examples:

```
scflow/update_conversion {"id":"<conversion>"}
scflow/update_conversion {"id":"<conversion>","display_name":"text","description":"text","tags":["text"]}
```

### `scflow/delete_conversion`

Delete a conversion. Deletes a conversion with its notes, and returns its id. The actor and the items are kept. The cascade parameter is accepted for consistency with the other delete actions and changes nothing.

Flags: destructive; writes `conversion`.

Parameters:
- `id` (id or name of conversion, required): Id or name of the conversion to delete.
- `cascade` (boolean): Has no effect: the notes of a conversion are always deleted with it.

Examples:

```
scflow/delete_conversion {"id":"<conversion>"}
scflow/delete_conversion {"id":"<conversion>","cascade":true}
```

### `scflow/add_note`

Add a note. Adds a Markdown note to an entity of the model (actor, flow, item, scope, type, transformation...) and returns it. The entity is given by its id. A plain string is stored as English text; give a map of language to string for other languages.

Flags: writes `note`.

Parameters:
- `annotated` (id or name of annotable, required): Id of the entity to annotate, whatever its kind.
- `content` (text or map language → text, required): Markdown text of the note.

Examples:

```
scflow/add_note {"annotated":"<annotable>","content":"text"}
```

### `scflow/update_note`

Update a note. Changes the content of a note and returns it. Each given language replaces the text of the same language, the other languages are kept. The note stays on its entity.

Flags: writes `note`.

Parameters:
- `id` (id or name of note, required): Id of the note to update.
- `content` (text or map language → text, required): New Markdown text; each given language replaces the same language.

Examples:

```
scflow/update_note {"id":"<note>","content":"text"}
```

### `scflow/remove_note`

Remove a note. Deletes a note and returns its id. The entity it annotated is not changed. The cascade parameter is accepted for consistency with the other delete actions and changes nothing.

Flags: destructive; writes `note`.

Parameters:
- `id` (id or name of note, required): Id of the note to delete.
- `cascade` (boolean): Has no effect: nothing depends on a note.

Examples:

```
scflow/remove_note {"id":"<note>"}
scflow/remove_note {"id":"<note>","cascade":true}
```

### `scflow/find_notes`

Find the notes of an entity. Lists the notes of an entity, given by its id: [{ id, entity, content }]. An entity without a note gives an empty list. It changes nothing.

Flags: read-only.

Parameters:
- `entity` (id or name of annotable, required): Id of the entity, whatever its kind.

Examples:

```
scflow/find_notes {"entity":"<annotable>"}
```

### `scflow/add_tags`

Add tags. Appends tags to an entity of the model (actor, flow, item, scope, type, transformation, conversion...) without removing its existing tags, and returns { id, tags }. Tags that the entity already carries are skipped. The entity is given by its id.

Flags: writes `annotable`.

Parameters:
- `entity` (id or name of annotable, required): Id of the entity to tag, whatever its kind.
- `tags` (list of string, required): Tags to add, at least one.

Examples:

```
scflow/add_tags {"entity":"<annotable>","tags":["text"]}
```

### `scflow/remove_tags`

Remove tags. Removes the given tags from an entity of the model (actor, flow, item, scope, type, transformation, conversion...) and returns { id, tags }. Tags that the entity does not carry are ignored. The entity is given by its id.

Flags: writes `annotable`.

Parameters:
- `entity` (id or name of annotable, required): Id of the entity to untag, whatever its kind.
- `tags` (list of string, required): Tags to remove, at least one.

Examples:

```
scflow/remove_tags {"entity":"<annotable>","tags":["text"]}
```

### `scflow/inspect_delete_impact`

Inspect the impact of a delete. Lists what deleting the given entities with cascade true would remove besides the entities themselves: actors, flows, items, held items, transformations, transformation lines, conversions and notes, with counts. An entity reached from several targets is counted once. It changes nothing.

Flags: read-only.

Parameters:
- `targets` (list of object, required): The entities to delete.

Examples:

```
scflow/inspect_delete_impact {"targets":[{}]}
```
