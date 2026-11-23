<!-- Generated from module.yaml by the build of the package. Do not edit. -->

# Supply chain flow: actions

### `scflow/create_actor`

Create an actor. Creates an actor of a given type in the network, optionally in a scope, at a location and inside a parent actor, and returns it. The scope defaults to the default scope of the type; the location has no default.

Flags: writes `actor`.

Parameters:
- `name` (string, required): Name of the actor, unique among the actors of the same parent actor or, at the root, of the same scope.
- `type` (reference (name or id) of actor_type, required): Id or name of the actor type. Give a name as short as it stays unambiguous, for example `Line 1`, or `Lyon / Line 1` when two plants have a line of that name; never give an id you were not given. An ambiguity error lists the candidates to choose from. A localized name may be given in any language, but it is written in the source language of the project.
- `scope` (reference (name or id) of scope): Id or name of the containing scope; the default scope of the type when omitted. Give a name as short as it stays unambiguous, for example `Line 1`, or `Lyon / Line 1` when two plants have a line of that name; never give an id you were not given. An ambiguity error lists the candidates to choose from. A localized name may be given in any language, but it is written in the source language of the project.
- `location` (reference (name or id) of location): Id or name of the location of the actor; none when omitted. Give a name as short as it stays unambiguous, for example `Line 1`, or `Lyon / Line 1` when two plants have a line of that name; never give an id you were not given. An ambiguity error lists the candidates to choose from.
- `parent_actor` (reference (name or id) of actor): Id or name of the parent actor, to nest the actor in a hierarchy. Give a name as short as it stays unambiguous, for example `Line 1`, or `Lyon / Line 1` when two plants have a line of that name; never give an id you were not given. An ambiguity error lists the candidates to choose from.
- `description` (text or map language → text): Markdown description of the actor.
- `tags` (list of string): Tags of the actor.

Examples:

```
scflow/create_actor {"name":"text","type":"<actor_type>"}
scflow/create_actor {"name":"text","type":"<actor_type>","scope":"<scope>","location":"<location>","parent_actor":"<actor>","description":"text","tags":["text"]}
```

### `scflow/update_actor`

Update an actor. Changes the name, description, type, scope, location, parent or tags of an actor and returns it. Only the given properties change; scope, location and parent_actor accept null to clear the relation. A change that breaks a rule on the held items, the flows or the parent of the actor is refused.

Flags: writes `actor`.

Parameters:
- `id` (reference (name or id) of actor, required): Id or name of the actor to update. Give a name as short as it stays unambiguous, for example `Line 1`, or `Lyon / Line 1` when two plants have a line of that name; never give an id you were not given. An ambiguity error lists the candidates to choose from.
- `name` (string): New name of the actor.
- `description` (text or map language → text): New Markdown description; each given language replaces the same language, the others are kept.
- `type` (reference (name or id) of actor_type): Id or name of the new actor type. Give a name as short as it stays unambiguous, for example `Line 1`, or `Lyon / Line 1` when two plants have a line of that name; never give an id you were not given. An ambiguity error lists the candidates to choose from. A localized name may be given in any language, but it is written in the source language of the project.
- `scope` (reference (name or id) of scope): Id or name of the new scope, or null to detach the actor from its scope. Give a name as short as it stays unambiguous, for example `Line 1`, or `Lyon / Line 1` when two plants have a line of that name; never give an id you were not given. An ambiguity error lists the candidates to choose from. A localized name may be given in any language, but it is written in the source language of the project.
- `location` (reference (name or id) of location): Id or name of the new location, or null to remove the location of the actor. Give a name as short as it stays unambiguous, for example `Line 1`, or `Lyon / Line 1` when two plants have a line of that name; never give an id you were not given. An ambiguity error lists the candidates to choose from.
- `parent_actor` (reference (name or id) of actor): Id or name of the new parent actor, or null to move the actor to the root. Give a name as short as it stays unambiguous, for example `Line 1`, or `Lyon / Line 1` when two plants have a line of that name; never give an id you were not given. An ambiguity error lists the candidates to choose from.
- `tags` (list of string): New tags; they replace the current ones.

Examples:

```
scflow/update_actor {"id":"<actor>"}
scflow/update_actor {"id":"<actor>","name":"text","description":"text","type":"<actor_type>","scope":"<scope>","location":"<location>","parent_actor":"<actor>","tags":["text"]}
```

### `scflow/delete_actor`

Delete an actor. Deletes an actor. It is refused while child actors, flows, held items, transformations, conversions or stops of routes reference the actor, unless cascade is true, which deletes the child actors recursively, the flows incident to the actor and its descendants, the items they hold, their transformations and conversions, the stops of routes at them, and the notes of every deleted entity.

Flags: destructive; writes `actor`, `flow`, `item_at_actor`, `transformation`, `transformation_line`, `conversion`, `route_stop`.

Parameters:
- `id` (reference (name or id) of actor, required): Id or name of the actor to delete. Give a name as short as it stays unambiguous, for example `Line 1`, or `Lyon / Line 1` when two plants have a line of that name; never give an id you were not given. An ambiguity error lists the candidates to choose from.
- `cascade` (boolean): When true, also deletes the descendant actors, the incident flows, the held items, the transformations, the conversions and the notes.

Examples:

```
scflow/delete_actor {"id":"<actor>"}
scflow/delete_actor {"id":"<actor>","cascade":true}
```

### `scflow/delete_actor_type`

Delete an actor type. Deletes an actor type. It is refused while actors have this type, unless cascade is true, which deletes those actors first, each with the cascade of scflow/delete_actor.

Flags: destructive; writes `actor`, `flow`, `item_at_actor`, `transformation`, `transformation_line`, `conversion`, `route_stop`, `actor_type`.

Parameters:
- `id` (reference (name or id) of actor_type, required): Id or name of the actor type to delete. Give a name as short as it stays unambiguous, for example `Line 1`, or `Lyon / Line 1` when two plants have a line of that name; never give an id you were not given. An ambiguity error lists the candidates to choose from. A localized name may be given in any language, but it is written in the source language of the project.
- `cascade` (boolean): When true, also deletes the actors of this type with their descendants, flows, held items, transformations and notes.

Examples:

```
scflow/delete_actor_type {"id":"<actor_type>"}
scflow/delete_actor_type {"id":"<actor_type>","cascade":true}
```

### `scflow/delete_scope`

Delete a scope. Deletes a scope. It is refused while actors are assigned to it, unless cascade is true, which deletes those actors first, each with the cascade of scflow/delete_actor. The default scope of an actor type that names the scope is cleared.

Flags: destructive; writes `actor`, `flow`, `item_at_actor`, `transformation`, `transformation_line`, `conversion`, `route_stop`, `scope`, `actor_type`.

Parameters:
- `id` (reference (name or id) of scope, required): Id or name of the scope to delete. Give a name as short as it stays unambiguous, for example `Line 1`, or `Lyon / Line 1` when two plants have a line of that name; never give an id you were not given. An ambiguity error lists the candidates to choose from. A localized name may be given in any language, but it is written in the source language of the project.
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
- `name` (text or map language → text, required): Name of the actor type, a string or a map of language to string.
- `domains` (list of physical | information | financial | service): Flow domains of the type; physical when omitted.
- `default_scope` (reference (name or id) of scope): Id or name of the scope given to the actors of this type that name no scope. Give a name as short as it stays unambiguous, for example `Line 1`, or `Lyon / Line 1` when two plants have a line of that name; never give an id you were not given. An ambiguity error lists the candidates to choose from. A localized name may be given in any language, but it is written in the source language of the project.
- `description` (text or map language → text): Markdown description of the actor type.
- `tags` (list of string): Tags of the actor type.

Examples:

```
scflow/create_actor_type {"name":"text"}
scflow/create_actor_type {"name":"text","domains":["physical"],"default_scope":"<scope>","description":"text","tags":["text"]}
```

### `scflow/create_scope`

Create a scope. Creates a scope, a lane that groups actors (for example SOURCE, MAKE, DELIVER or a region), and returns it.

Flags: writes `scope`.

Parameters:
- `name` (text or map language → text, required): Name of the scope, a string or a map of language to string.
- `description` (text or map language → text): Markdown description of the scope.
- `group` (string): Name of the group of scopes this scope is in (a region, a stage); empty or omitted when it is in none.
- `group_index` (integer): Position of the scope in its group, from 1.
- `tags` (list of string): Tags of the scope.

Examples:

```
scflow/create_scope {"name":"text"}
scflow/create_scope {"name":"text","description":"text","group":"text","group_index":1,"tags":["text"]}
```

### `scflow/create_flow`

Create a flow. Creates a flow from a source actor to a destination actor and returns it. Set bidirectional to true so that the flow carries items in both directions; it is one-way otherwise. A flow has no name: its source, destination, item and route identify it, and the description holds what else there is to say. A flow carries at most one item, given by item. A flow between an actor and one of its child actors, in either direction, must carry an item, otherwise the action fails. The domain of the item must be among the domains of both actors, and the actors that do not hold the item yet hold it afterwards. Give route to make the flow travel on an existing route, as scflow/set_flow_route does; creating a flow never creates a route.

Flags: writes `flow`, `item_at_actor`.

Parameters:
- `source` (reference (name or id) of actor, required): Id or name of the actor the flow starts from. Give a name as short as it stays unambiguous, for example `Line 1`, or `Lyon / Line 1` when two plants have a line of that name; never give an id you were not given. An ambiguity error lists the candidates to choose from.
- `destination` (reference (name or id) of actor, required): Id or name of the actor the flow arrives at. Give a name as short as it stays unambiguous, for example `Line 1`, or `Lyon / Line 1` when two plants have a line of that name; never give an id you were not given. An ambiguity error lists the candidates to choose from.
- `item` (reference (name or id) of item): Id or name of the item the flow carries; required between an actor and its child. Give a name as short as it stays unambiguous, for example `Line 1`, or `Lyon / Line 1` when two plants have a line of that name; never give an id you were not given. An ambiguity error lists the candidates to choose from.
- `bidirectional` (boolean): Whether the flow carries items in both directions; false when omitted.
- `route` (reference (name or id) of route): Id or name of the route the flow travels on; none when omitted. Give a name as short as it stays unambiguous, for example `Line 1`, or `Lyon / Line 1` when two plants have a line of that name; never give an id you were not given. An ambiguity error lists the candidates to choose from.
- `description` (text or map language → text): Markdown description of the flow.
- `tags` (list of string): Tags of the flow.

Examples:

```
scflow/create_flow {"source":"<actor>","destination":"<actor>"}
scflow/create_flow {"source":"<actor>","destination":"<actor>","item":"<item>","bidirectional":true,"route":"<route>","description":"text","tags":["text"]}
```

### `scflow/update_flow`

Update a flow. Changes the bidirectional flag, the description or the tags of a flow and returns it. Only the given properties change. The source and the destination of a flow never change: delete the flow and create it again. Making a flow bidirectional is refused when its route does not serve the other direction. Its route changes with scflow/set_flow_route.

Flags: writes `flow`.

Parameters:
- `id` (id of flow, required): Id of the flow to update.
- `bidirectional` (boolean): Whether the flow carries items in both directions.
- `description` (text or map language → text): New Markdown description; each given language replaces the same language, the others are kept.
- `tags` (list of string): New tags; they replace the current ones.

Examples:

```
scflow/update_flow {"id":"<flow>"}
scflow/update_flow {"id":"<flow>","bidirectional":true,"description":"text","tags":["text"]}
```

### `scflow/set_flow_item`

Set the item of a flow. Sets the item carried by a flow that carries none, and returns the flow. The item of a flow never changes and is never removed: the action fails when the flow carries another item, and changes nothing when it already carries this one. The domain of the item must be among the domains of both the source and the destination, and the actors that do not hold the item yet hold it afterwards.

Flags: writes `flow`, `item_at_actor`.

Parameters:
- `id` (id of flow, required): Id of the flow.
- `item` (reference (name or id) of item, required): Id or name of the item. Give a name as short as it stays unambiguous, for example `Line 1`, or `Lyon / Line 1` when two plants have a line of that name; never give an id you were not given. An ambiguity error lists the candidates to choose from.

Examples:

```
scflow/set_flow_item {"id":"<flow>","item":"<item>"}
```

### `scflow/delete_flow`

Delete a flow. Deletes a flow and returns its id. The items held by its ends are kept. The cascade parameter is accepted for consistency with the other delete actions and changes nothing.

Flags: destructive; writes `flow`.

Parameters:
- `id` (id of flow, required): Id of the flow to delete.
- `cascade` (boolean): Has no effect: nothing depends on a flow but its notes, which are always deleted with it.

Examples:

```
scflow/delete_flow {"id":"<flow>"}
scflow/delete_flow {"id":"<flow>","cascade":true}
```

### `scflow/create_mode`

Create a mode. Creates a mode, the category of transport or exchange such as road, sea, air, rail, EDI or payment, bound to one flow domain (physical, information, financial or service), and returns it. A mode is the category; a route is the instance.

Flags: writes `mode`.

Parameters:
- `name` (text or map language → text, required): Name of the mode, a string or a map of language to string.
- `domain` (physical | information | financial | service, required): The flow domain of the routes of this mode.
- `description` (text or map language → text): Markdown description of the mode.
- `tags` (list of string): Tags of the mode.

Examples:

```
scflow/create_mode {"name":"text","domain":"physical"}
scflow/create_mode {"name":"text","domain":"physical","description":"text","tags":["text"]}
```

### `scflow/delete_mode`

Delete a mode. Deletes a mode. It is refused while routes have this mode, unless cascade is true, which deletes those routes first, each with the cascade of scflow/delete_route: their stops are deleted and their flows are kept, on no route.

Flags: destructive; writes `mode`, `route`, `route_stop`, `flow`.

Parameters:
- `id` (reference (name or id) of mode, required): Id or name of the mode to delete. Give a name as short as it stays unambiguous, for example `Line 1`, or `Lyon / Line 1` when two plants have a line of that name; never give an id you were not given. An ambiguity error lists the candidates to choose from. A localized name may be given in any language, but it is written in the source language of the project.
- `cascade` (boolean): When true, also deletes the routes of this mode with their stops and notes; their flows are kept.

Examples:

```
scflow/delete_mode {"id":"<mode>"}
scflow/delete_mode {"id":"<mode>","cascade":true}
```

### `scflow/create_route`

Create a route. Creates a route, the instance that says how flows travel (a shuttle, a weekly round trip, an EDI link), of a given mode, with no stop and no flow yet, and returns it. Add its stops with scflow/add_route_stop and assign flows with scflow/set_flow_route. Set bidirectional to true when the stops are served in both orders; it is false otherwise. The schedule is a free text.

Flags: writes `route`.

Parameters:
- `name` (string, required): Name of the route, unique among the routes.
- `mode` (reference (name or id) of mode, required): Id or name of the mode. Give a name as short as it stays unambiguous, for example `Line 1`, or `Lyon / Line 1` when two plants have a line of that name; never give an id you were not given. An ambiguity error lists the candidates to choose from. A localized name may be given in any language, but it is written in the source language of the project.
- `description` (text or map language → text): Markdown description of the route.
- `schedule` (text or map language → text): Schedule of the route as a free text, such as every Monday.
- `bidirectional` (boolean): Whether the stops are served in both orders; false when omitted.
- `tags` (list of string): Tags of the route.

Examples:

```
scflow/create_route {"name":"text","mode":"<mode>"}
scflow/create_route {"name":"text","mode":"<mode>","description":"text","schedule":"text","bidirectional":true,"tags":["text"]}
```

### `scflow/update_route`

Update a route. Changes the name, description, mode, schedule, bidirectional flag or tags of a route and returns it. Only the given properties change; null clears the description or the schedule. A change of mode whose domain differs from the items of the flows of the route is refused, and so is making a route one-way while a flow needs it in the other direction.

Flags: writes `route`.

Parameters:
- `id` (reference (name or id) of route, required): Id or name of the route to update. Give a name as short as it stays unambiguous, for example `Line 1`, or `Lyon / Line 1` when two plants have a line of that name; never give an id you were not given. An ambiguity error lists the candidates to choose from.
- `name` (string): New name of the route.
- `description` (text or map language → text): New Markdown description; each given language replaces the same language, the others are kept. null removes the description.
- `mode` (reference (name or id) of mode): Id or name of the new mode. Give a name as short as it stays unambiguous, for example `Line 1`, or `Lyon / Line 1` when two plants have a line of that name; never give an id you were not given. An ambiguity error lists the candidates to choose from. A localized name may be given in any language, but it is written in the source language of the project.
- `schedule` (text or map language → text): New schedule; each given language replaces the same language, the others are kept. null removes the schedule.
- `bidirectional` (boolean): Whether the stops are served in both orders.
- `tags` (list of string): New tags; they replace the current ones.

Examples:

```
scflow/update_route {"id":"<route>"}
scflow/update_route {"id":"<route>","name":"text","description":"text","mode":"<mode>","schedule":"text","bidirectional":true,"tags":["text"]}
```

### `scflow/delete_route`

Delete a route. Deletes a route with its stops and notes, and returns its id. It is refused while flows travel on the route, unless cascade is true, which keeps those flows and clears their route.

Flags: destructive; writes `route`, `route_stop`, `flow`.

Parameters:
- `id` (reference (name or id) of route, required): Id or name of the route to delete. Give a name as short as it stays unambiguous, for example `Line 1`, or `Lyon / Line 1` when two plants have a line of that name; never give an id you were not given. An ambiguity error lists the candidates to choose from.
- `cascade` (boolean): When true, also clears the route of the flows that travel on it; the flows are kept.

Examples:

```
scflow/delete_route {"id":"<route>"}
scflow/delete_route {"id":"<route>","cascade":true}
```

### `scflow/add_route_stop`

Add a stop to a route. Adds a stop at an actor to a route, at the position given by sequence (1 for the first stop), or after the last stop when sequence is omitted, and returns it. The stops from that position on move one place down. An actor may have several stops on one route, such as the start and the end of a round trip. lead_time is the ISO 8601 duration of the leg from the previous stop, such as P2D or PT4H30M, and is ignored on the first stop; reverse_lead_time is the duration of the same leg backwards on a bidirectional route, equal to lead_time when omitted.

Flags: writes `route_stop`.

Parameters:
- `route` (reference (name or id) of route, required): Id or name of the route. Give a name as short as it stays unambiguous, for example `Line 1`, or `Lyon / Line 1` when two plants have a line of that name; never give an id you were not given. An ambiguity error lists the candidates to choose from.
- `actor` (reference (name or id) of actor, required): Id or name of the actor of the stop. Give a name as short as it stays unambiguous, for example `Line 1`, or `Lyon / Line 1` when two plants have a line of that name; never give an id you were not given. An ambiguity error lists the candidates to choose from.
- `sequence` (integer): Position of the stop, from 1; after the last stop when omitted.
- `lead_time` (string): ISO 8601 duration of the leg from the previous stop to this one.
- `reverse_lead_time` (string): ISO 8601 duration of the leg from this stop back to the previous one; lead_time when omitted.
- `tags` (list of string): Tags of the stop.

Examples:

```
scflow/add_route_stop {"route":"<route>","actor":"<actor>"}
scflow/add_route_stop {"route":"<route>","actor":"<actor>","sequence":1,"lead_time":"text","reverse_lead_time":"text","tags":["text"]}
```

### `scflow/update_route_stop`

Update a stop of a route. Moves a stop of a route to another position, given by sequence, or changes its lead times or tags, and returns it. The other stops keep their order. null clears a lead time. A move after which the route no longer serves one of its flows, a stop of the source before a stop of the destination, is refused.

Flags: writes `route_stop`.

Parameters:
- `id` (id of route_stop, required): Id of the stop.
- `sequence` (integer): New position of the stop, from 1, at most the number of stops.
- `lead_time` (string,null): New ISO 8601 duration of the leg from the previous stop; null clears it.
- `reverse_lead_time` (string,null): New ISO 8601 duration of the leg backwards; null clears it.
- `tags` (list of string): New tags; they replace the current ones.

Examples:

```
scflow/update_route_stop {"id":"<route_stop>"}
scflow/update_route_stop {"id":"<route_stop>","sequence":1,"lead_time":"text","reverse_lead_time":"text","tags":["text"]}
```

### `scflow/remove_route_stop`

Remove a stop from a route. Removes a stop from its route and returns its id; the following stops move one place up. It is refused when a flow of the route needs the stop: its source or destination would no longer be a stop, or no stop of its source would come before a stop of its destination. The cascade parameter is accepted for consistency with the other delete actions and changes nothing.

Flags: destructive; writes `route_stop`.

Parameters:
- `id` (id of route_stop, required): Id of the stop to remove.
- `cascade` (boolean): Has no effect: nothing depends on a stop but its notes, which are always deleted with it.

Examples:

```
scflow/remove_route_stop {"id":"<route_stop>"}
scflow/remove_route_stop {"id":"<route_stop>","cascade":true}
```

### `scflow/set_flow_route`

Set the route of a flow. Makes a flow travel on a route, or on none with null, and returns the flow. A flow travels on at most one route, so this replaces its route. The source and the destination of the flow must be stops of the route, a stop of the source before a stop of the destination unless the route is bidirectional; a bidirectional flow also needs the other direction. The item of the flow must be in the domain of the mode.

Flags: writes `flow`.

Parameters:
- `id` (id of flow, required): Id of the flow.
- `route` (reference (name or id) of route, required): Id or name of the route, or null to take the flow off its route. Give a name as short as it stays unambiguous, for example `Line 1`, or `Lyon / Line 1` when two plants have a line of that name; never give an id you were not given. An ambiguity error lists the candidates to choose from.

Examples:

```
scflow/set_flow_route {"id":"<flow>","route":"<route>"}
```

### `scflow/create_route_from_flows`

Create a route from flows. Creates a route of a given mode for flows that share their source and their destination and travel on no route yet, with two stops, the source then the destination, makes the flows travel on it and returns it. The items of the flows must be in the domain of the mode. lead_time is the ISO 8601 duration from the source to the destination. The route is bidirectional when bidirectional is true, or when it is omitted and one of the flows is bidirectional.

Flags: writes `route`, `route_stop`, `flow`.

Parameters:
- `flows` (list of id of flow, required): Ids of the flows, at least one.
- `mode` (reference (name or id) of mode, required): Id or name of the mode. Give a name as short as it stays unambiguous, for example `Line 1`, or `Lyon / Line 1` when two plants have a line of that name; never give an id you were not given. An ambiguity error lists the candidates to choose from. A localized name may be given in any language, but it is written in the source language of the project.
- `name` (string, required): Name of the route, unique among the routes.
- `description` (text or map language → text): Markdown description of the route.
- `schedule` (text or map language → text): Schedule of the route as a free text, such as every Monday.
- `bidirectional` (boolean): Whether the route serves its stops in both orders; true when omitted and a flow is bidirectional.
- `lead_time` (string): ISO 8601 duration from the source to the destination.
- `reverse_lead_time` (string): ISO 8601 duration from the destination back to the source; lead_time when omitted.
- `tags` (list of string): Tags of the route.

Examples:

```
scflow/create_route_from_flows {"flows":["<flow>"],"mode":"<mode>","name":"text"}
scflow/create_route_from_flows {"flows":["<flow>"],"mode":"<mode>","name":"text","description":"text","schedule":"text","bidirectional":true,"lead_time":"text","reverse_lead_time":"text","tags":["text"]}
```

### `scflow/inspect_route`

Inspect a route. Describes a route: its mode and domain, its stops in order with their lead times, and each of its flows with its lead time, the sum of the lead times of the legs from a stop of its source to a stop of its destination; a bidirectional flow also has the lead time back. A lead time is null when a leg of the path has none. stops_without_flow lists the stops that are the end of no flow of the route, such as a transit hub or a truck depot where a round trip starts and ends. It changes nothing.

Flags: read-only.

Parameters:
- `id` (reference (name or id) of route, required): Id or name of the route. Give a name as short as it stays unambiguous, for example `Line 1`, or `Lyon / Line 1` when two plants have a line of that name; never give an id you were not given. An ambiguity error lists the candidates to choose from.

Examples:

```
scflow/inspect_route {"id":"<route>"}
```

### `scflow/create_item_type`

Create an item type. Creates an item type, a category of items bound to one flow domain (physical, information, financial or service), and returns it.

Flags: writes `item_type`.

Parameters:
- `name` (text or map language → text, required): Name of the item type, a string or a map of language to string.
- `domain` (physical | information | financial | service, required): The flow domain of the items of this type.
- `description` (text or map language → text): Markdown description of the item type.
- `tags` (list of string): Tags of the item type.

Examples:

```
scflow/create_item_type {"name":"text","domain":"physical"}
scflow/create_item_type {"name":"text","domain":"physical","description":"text","tags":["text"]}
```

### `scflow/create_item`

Create an item. Creates an item, a family of things the network moves and holds, of a given item type, and returns it.

Flags: writes `item`.

Parameters:
- `name` (string, required): Name of the item, unique among the items; a code such as a SKU is a name, other details go in the description.
- `type` (reference (name or id) of item_type, required): Id or name of the item type. Give a name as short as it stays unambiguous, for example `Line 1`, or `Lyon / Line 1` when two plants have a line of that name; never give an id you were not given. An ambiguity error lists the candidates to choose from. A localized name may be given in any language, but it is written in the source language of the project.
- `description` (text or map language → text): Markdown description of the item.
- `tags` (list of string): Tags of the item.

Examples:

```
scflow/create_item {"name":"text","type":"<item_type>"}
scflow/create_item {"name":"text","type":"<item_type>","description":"text","tags":["text"]}
```

### `scflow/update_item`

Update an item. Changes the name, description or type of an item and returns it. Only the given properties change. A change of type that breaks a rule on the held records of the item or the flows that carry it is refused.

Flags: writes `item`.

Parameters:
- `id` (reference (name or id) of item, required): Id or name of the item to update. Give a name as short as it stays unambiguous, for example `Line 1`, or `Lyon / Line 1` when two plants have a line of that name; never give an id you were not given. An ambiguity error lists the candidates to choose from.
- `name` (string): New name of the item.
- `description` (text or map language → text): New Markdown description; each given language replaces the same language, the others are kept.
- `type` (reference (name or id) of item_type): Id or name of the new item type. Give a name as short as it stays unambiguous, for example `Line 1`, or `Lyon / Line 1` when two plants have a line of that name; never give an id you were not given. An ambiguity error lists the candidates to choose from. A localized name may be given in any language, but it is written in the source language of the project.
- `tags` (list of string): New tags; they replace the current ones.

Examples:

```
scflow/update_item {"id":"<item>"}
scflow/update_item {"id":"<item>","name":"text","description":"text","type":"<item_type>","tags":["text"]}
```

### `scflow/hold_item`

Hold an item at an actor. Makes an actor hold an item (inventory, queue, cash or backlog) and returns the record. The domain of the item must be among the domains of the actor. When the actor already holds the item, the existing record is returned.

Flags: writes `item_at_actor`.

Parameters:
- `actor` (reference (name or id) of actor, required): Id or name of the actor. Give a name as short as it stays unambiguous, for example `Line 1`, or `Lyon / Line 1` when two plants have a line of that name; never give an id you were not given. An ambiguity error lists the candidates to choose from.
- `item` (reference (name or id) of item, required): Id or name of the item. Give a name as short as it stays unambiguous, for example `Line 1`, or `Lyon / Line 1` when two plants have a line of that name; never give an id you were not given. An ambiguity error lists the candidates to choose from.
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
- `id` (id of item_at_actor, required): Id of the item-at-actor record to remove.
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
- `id` (reference (name or id) of item, required): Id or name of the item to delete. Give a name as short as it stays unambiguous, for example `Line 1`, or `Lyon / Line 1` when two plants have a line of that name; never give an id you were not given. An ambiguity error lists the candidates to choose from.
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
- `id` (reference (name or id) of item_type, required): Id or name of the item type to delete. Give a name as short as it stays unambiguous, for example `Line 1`, or `Lyon / Line 1` when two plants have a line of that name; never give an id you were not given. An ambiguity error lists the candidates to choose from. A localized name may be given in any language, but it is written in the source language of the project.
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
- `name` (text or map language → text, required): Name of the transformation type, a string or a map of language to string.
- `description` (text or map language → text): Markdown description of the transformation type.
- `tags` (list of string): Tags of the transformation type.

Examples:

```
scflow/create_transformation_type {"name":"text"}
scflow/create_transformation_type {"name":"text","description":"text","tags":["text"]}
```

### `scflow/create_transformation`

Create a transformation. Creates a transformation of a given type inside an actor, with no line yet, and returns it. Its name is required and has no default; it is unique among the transformations of the actor.

Flags: writes `transformation`.

Parameters:
- `actor` (reference (name or id) of actor, required): Id or name of the actor that executes the transformation. Give a name as short as it stays unambiguous, for example `Line 1`, or `Lyon / Line 1` when two plants have a line of that name; never give an id you were not given. An ambiguity error lists the candidates to choose from.
- `type` (reference (name or id) of transformation_type, required): Id or name of the transformation type. Give a name as short as it stays unambiguous, for example `Line 1`, or `Lyon / Line 1` when two plants have a line of that name; never give an id you were not given. An ambiguity error lists the candidates to choose from. A localized name may be given in any language, but it is written in the source language of the project.
- `name` (string, required): Name of the transformation, unique among the transformations of the actor, such as Assembly.
- `description` (text or map language → text): Markdown description of the transformation.
- `tags` (list of string): Tags of the transformation.

Examples:

```
scflow/create_transformation {"actor":"<actor>","type":"<transformation_type>","name":"text"}
scflow/create_transformation {"actor":"<actor>","type":"<transformation_type>","name":"text","description":"text","tags":["text"]}
```

### `scflow/connect_transformation_line`

Connect a transformation line. Connects an item held by the actor of a transformation to that transformation, as an input (consumed) or an output (produced), and returns the line. When the same line exists, it is returned. Give the id of the held-item record.

Flags: writes `transformation_line`.

Parameters:
- `transformation` (reference (name or id) of transformation, required): Id or name of the transformation. Give a name as short as it stays unambiguous, for example `Line 1`, or `Lyon / Line 1` when two plants have a line of that name; never give an id you were not given. An ambiguity error lists the candidates to choose from.
- `held_item` (id of item_at_actor, required): Id of the item-at-actor record, held by the actor of the transformation.
- `role` (consumed | produced, required): Whether the transformation consumes or produces the item.
- `tags` (list of string): Tags of the line, when the action creates it.

Examples:

```
scflow/connect_transformation_line {"transformation":"<transformation>","held_item":"<item_at_actor>","role":"consumed"}
scflow/connect_transformation_line {"transformation":"<transformation>","held_item":"<item_at_actor>","role":"consumed","tags":["text"]}
```

### `scflow/define_process`

Define a process. Creates a named transformation of a given type at an actor, makes the actor hold the consumed and produced items that it does not hold yet, and attaches a line for each of them, in one step. Every item must be in a domain of the actor. Returns the transformation and its lines.

Flags: writes `transformation`, `item_at_actor`, `transformation_line`.

Parameters:
- `actor` (reference (name or id) of actor, required): Id or name of the actor. Give a name as short as it stays unambiguous, for example `Line 1`, or `Lyon / Line 1` when two plants have a line of that name; never give an id you were not given. An ambiguity error lists the candidates to choose from.
- `transformation_type` (reference (name or id) of transformation_type, required): Id or name of the transformation type. Give a name as short as it stays unambiguous, for example `Line 1`, or `Lyon / Line 1` when two plants have a line of that name; never give an id you were not given. An ambiguity error lists the candidates to choose from. A localized name may be given in any language, but it is written in the source language of the project.
- `name` (string, required): Name of the transformation, unique among the transformations of the actor, such as Assembly.
- `consumed_items` (list of reference (name or id) of item): Items consumed, each an id or a name. Give a name as short as it stays unambiguous, for example `Line 1`, or `Lyon / Line 1` when two plants have a line of that name; never give an id you were not given. An ambiguity error lists the candidates to choose from.
- `produced_items` (list of reference (name or id) of item): Items produced, each an id or a name. Give a name as short as it stays unambiguous, for example `Line 1`, or `Lyon / Line 1` when two plants have a line of that name; never give an id you were not given. An ambiguity error lists the candidates to choose from.

Examples:

```
scflow/define_process {"actor":"<actor>","transformation_type":"<transformation_type>","name":"text"}
scflow/define_process {"actor":"<actor>","transformation_type":"<transformation_type>","name":"text","consumed_items":["<item>"],"produced_items":["<item>"]}
```

### `scflow/delete_transformation`

Delete a transformation. Deletes a transformation with its lines and notes, and returns its id. The held items that its lines used are kept. The cascade parameter is accepted for consistency with the other delete actions and changes nothing.

Flags: destructive; writes `transformation`, `transformation_line`.

Parameters:
- `id` (reference (name or id) of transformation, required): Id or name of the transformation to delete. Give a name as short as it stays unambiguous, for example `Line 1`, or `Lyon / Line 1` when two plants have a line of that name; never give an id you were not given. An ambiguity error lists the candidates to choose from.
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
- `id` (reference (name or id) of transformation_type, required): Id or name of the transformation type to delete. Give a name as short as it stays unambiguous, for example `Line 1`, or `Lyon / Line 1` when two plants have a line of that name; never give an id you were not given. An ambiguity error lists the candidates to choose from. A localized name may be given in any language, but it is written in the source language of the project.
- `cascade` (boolean): When true, also deletes the transformations of this type with their lines and notes.

Examples:

```
scflow/delete_transformation_type {"id":"<transformation_type>"}
scflow/delete_transformation_type {"id":"<transformation_type>","cascade":true}
```

### `scflow/create_conversion`

Create a conversion. Creates a conversion, which turns one item into another item at an actor, and returns it. The two items must be in the same flow domain, and they cannot change afterwards. A conversion has no name: its actor and its two items identify it, and the description holds what else there is to say. The description and the tags are optional.

Flags: writes `conversion`.

Parameters:
- `actor` (reference (name or id) of actor, required): Id or name of the actor where the conversion takes place. Give a name as short as it stays unambiguous, for example `Line 1`, or `Lyon / Line 1` when two plants have a line of that name; never give an id you were not given. An ambiguity error lists the candidates to choose from.
- `from_item` (reference (name or id) of item, required): Id or name of the item that is converted. Give a name as short as it stays unambiguous, for example `Line 1`, or `Lyon / Line 1` when two plants have a line of that name; never give an id you were not given. An ambiguity error lists the candidates to choose from.
- `to_item` (reference (name or id) of item, required): Id or name of the item that results; it has the domain of from_item. Give a name as short as it stays unambiguous, for example `Line 1`, or `Lyon / Line 1` when two plants have a line of that name; never give an id you were not given. An ambiguity error lists the candidates to choose from.
- `description` (text or map language → text): Markdown description of the conversion.
- `tags` (list of string): Tags of the conversion.

Examples:

```
scflow/create_conversion {"actor":"<actor>","from_item":"<item>","to_item":"<item>"}
scflow/create_conversion {"actor":"<actor>","from_item":"<item>","to_item":"<item>","description":"text","tags":["text"]}
```

### `scflow/update_conversion`

Update a conversion. Changes the description or the tags of a conversion and returns it. Only the given properties change; null clears the description, and tags replaces the whole list. The actor and the two items of a conversion never change: to change them, delete the conversion and create another.

Flags: writes `conversion`.

Parameters:
- `id` (id of conversion, required): Id of the conversion to update.
- `description` (text or map language → text): New Markdown description; each given language replaces the same language, the others are kept. null removes the description.
- `tags` (list of string): New tags; they replace the current ones.

Examples:

```
scflow/update_conversion {"id":"<conversion>"}
scflow/update_conversion {"id":"<conversion>","description":"text","tags":["text"]}
```

### `scflow/delete_conversion`

Delete a conversion. Deletes a conversion with its notes, and returns its id. The actor and the items are kept. The cascade parameter is accepted for consistency with the other delete actions and changes nothing.

Flags: destructive; writes `conversion`.

Parameters:
- `id` (id of conversion, required): Id of the conversion to delete.
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
- `annotated` (id of annotable, required): Id of the entity to annotate, whatever its kind.
- `content` (text or map language → text, required): Markdown text of the note.

Examples:

```
scflow/add_note {"annotated":"<annotable>","content":"text"}
```

### `scflow/update_note`

Update a note. Changes the content of a note and returns it. Each given language replaces the text of the same language, the other languages are kept. The note stays on its entity.

Flags: writes `note`.

Parameters:
- `id` (id of note, required): Id of the note to update.
- `content` (text or map language → text, required): New Markdown text; each given language replaces the same language.

Examples:

```
scflow/update_note {"id":"<note>","content":"text"}
```

### `scflow/remove_note`

Remove a note. Deletes a note and returns its id. The entity it annotated is not changed. The cascade parameter is accepted for consistency with the other delete actions and changes nothing.

Flags: destructive; writes `note`.

Parameters:
- `id` (id of note, required): Id of the note to delete.
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
- `entity` (id of annotable, required): Id of the entity, whatever its kind.

Examples:

```
scflow/find_notes {"entity":"<annotable>"}
```

### `scflow/add_tags`

Add tags. Appends tags to an entity of the model (actor, flow, item, scope, type, transformation, conversion...) without removing its existing tags, and returns { id, tags }. Tags that the entity already carries are skipped. The entity is given by its id.

Flags: writes `annotable`.

Parameters:
- `entity` (id of annotable, required): Id of the entity to tag, whatever its kind.
- `tags` (list of string, required): Tags to add, at least one.

Examples:

```
scflow/add_tags {"entity":"<annotable>","tags":["text"]}
```

### `scflow/remove_tags`

Remove tags. Removes the given tags from an entity of the model (actor, flow, item, scope, type, transformation, conversion...) and returns { id, tags }. Tags that the entity does not carry are ignored. The entity is given by its id.

Flags: writes `annotable`.

Parameters:
- `entity` (id of annotable, required): Id of the entity to untag, whatever its kind.
- `tags` (list of string, required): Tags to remove, at least one.

Examples:

```
scflow/remove_tags {"entity":"<annotable>","tags":["text"]}
```

### `scflow/inspect_delete_impact`

Inspect the impact of a delete. Lists what deleting the given entities with cascade true would remove besides the entities themselves: actors, flows, items, held items, transformations, transformation lines, conversions, stops of routes and notes, with counts. An entity reached from several targets is counted once. It changes nothing.

Flags: read-only.

Parameters:
- `targets` (list of object, required): The entities to delete.

Examples:

```
scflow/inspect_delete_impact {"targets":[{}]}
```
