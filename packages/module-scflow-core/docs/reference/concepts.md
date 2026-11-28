<!-- Generated from module.yaml by the build of the package. Do not edit. -->

# Supply chain flow: concepts

### note

A free-form annotation of one entity, written in one or more languages.

- `annotated`: → annotable (owner, inverse `notes`)
- `content`: localized_markdown

### actor_type

A type of actor, with the flow domains it belongs to.

Extends `annotable`.

- `name`: localized_string
- `description`: localized_markdown
- `domains`: physical | information | financial | service (many)
- `default_scope`: → scope

### item_type

A type of item, with the one flow domain it belongs to.

Extends `annotable`.

- `name`: localized_string
- `description`: localized_markdown
- `domain`: physical | information | financial | service

### flow_type

A type of flow, with the one flow domain it belongs to and the direction of its flows.

Extends `annotable`.

- `name`: localized_string
- `description`: localized_markdown
- `domain`: physical | information | financial | service
- `direction`: forward | same-level | reverse

### actor

A place in the network where items are held, consumed, produced or queued.

Extends `annotable`.

- `name`: string
- `description`: localized_markdown
- `type`: → actor_type (required, inverse `actors`)
- `scope`: → scope (inverse `actors`)
- `location`: → location (inverse `actors`)
- `parent_actor`: → actor (inverse `child_actors`)

### flow

A connection moving one optional item from a source actor to a destination actor.

Extends `annotable`.

- `description`: localized_markdown
- `source`: → actor (required, inverse `outgoing_flows`)
- `destination`: → actor (required, inverse `incoming_flows`)
- `type`: → flow_type (inverse `flows`)
- `item`: → item (inverse `carried_on`)
- `bidirectional`: boolean
- `route`: → route (inverse `flows`)

### item

A family of things the network moves and holds.

Extends `annotable`.

- `name`: string
- `description`: localized_markdown
- `type`: → item_type (required, inverse `items`)

### item_at_actor

An item held at an actor.

Extends `annotable`.

- `actor`: → actor (owner, inverse `held_items`)
- `item`: → item (required, inverse `held_at`)

### transformation_type

A type of transformation.

Extends `annotable`.

- `name`: localized_string
- `description`: localized_markdown

### transformation

A transformation of consumed items into produced items at an actor.

Extends `annotable`.

- `name`: string
- `description`: localized_markdown
- `type`: → transformation_type (required, inverse `transformations`)
- `actor`: → actor (owner, inverse `transformations`)

### transformation_line

One item consumed or produced by a transformation.

Extends `annotable`.

- `transformation`: → transformation (owner, inverse `lines`)
- `role`: consumed | produced
- `held_item`: → item_at_actor (required, inverse `transformation_lines`)

### conversion

A conversion of one item into another item at an actor.

Extends `annotable`.

- `description`: localized_markdown
- `actor`: → actor (owner, inverse `conversions`)
- `from_item`: → item (required)
- `to_item`: → item (required)

### route_type

A category of transport or exchange, such as road, sea, air, rail, EDI or payment, with the one flow domain it belongs to.

Extends `annotable`.

- `name`: localized_string
- `description`: localized_markdown
- `domain`: physical | information | financial | service

### route

How flows travel, an instance of a route type, such as a shuttle or a weekly round trip, serving ordered stops with a schedule and lead times.

Extends `annotable`.

- `name`: string
- `description`: localized_markdown
- `route_type`: → route_type (required, inverse `routes`)
- `schedule`: localized_string
- `bidirectional`: boolean

### route_stop

One ordered stop of a route at an actor, with the lead time from the previous stop.

Extends `annotable`.

- `route`: → route (owner, inverse `stops`)
- `actor`: → actor (required, inverse `route_stops`)
- `sequence`: integer
- `lead_time`: lead_time
- `reverse_lead_time`: lead_time

### scope

A flat grouping of actors, a swim lane of the graph.

Extends `annotable`.

- `name`: localized_string
- `description`: localized_markdown
- `group`: string
- `group_index`: integer

### location

A geographic place or site where actors operate.

Extends `annotable`.

- `name`: string
- `description`: localized_markdown
- `latitude`: latitude
- `longitude`: longitude
- `address`: string
- `postal_code`: string
- `city`: string
- `country_code`: country_code
- `un_locode`: un_locode
- `timezone`: string
