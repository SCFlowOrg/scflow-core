# The flow model

## Flow Network

*Concept.*

A **flow network** describes a supply chain through four entities: [items](#item) move between [actors](#actor) on [flows](#flow), and [transformations](#transformation) at an actor turn the items it consumes into the items it produces. An actor holds items; a flow carries items from one actor to another.

The same entities describe every [flow domain](#flow-domain) — a plant shipping products, an ERP system sending orders, a bank transferring payments, a service provider delivering interventions — so one network holds all four domains and the links between them, per [All Flow Domains](why-modelling-flows.md#all-flow-domains).

Every actor, flow and item has a [type](#typing) that gives it its business meaning. [Scopes](#scope) group actors into swim lanes.

A dataset describes one flow network: its actors, flows, items, transformations and scopes are instances of the dataset, and no instance stands for the network itself.

## Flow Domain

*Definition.*

A **flow domain** is the nature of what a flow network moves. It takes one of four values:

| Domain | What moves | What is held |
| --- | --- | --- |
| `physical` | Products, materials | Inventory |
| `information` | Messages, orders, invoices, data | Waiting queues |
| `financial` | Money, value | Cash, assets, liabilities, working capital |
| `service` | Service units | Work in progress, backlog |

The domain of an item is the domain of its type, and is exactly one. A [flow](#flow) declares no domain of its own: its domain is that of the item it carries or of its flow type, which agree, so a flow without an item takes its domain from its type, and a flow with neither has no domain. An actor's domains are the domains of its type, one or more: a plant is physical and information, a service provider is service and physical. The domain rules on [items at actors](#item-at-actor) and [flows](#flow) are stated with each of them.

## Actor

*Definition.*

An **actor** is a place in the network where items are held, consumed, produced or queued: a customer, a supplier, a plant, a production line, a warehouse, an ERP system, a planner, a bank, a service provider.

- Its `actor_type` is mandatory, can change, and gives its [domains](#flow-domain), one or more.
- It has a name, unique among the actors that share its parent actor or, at the root, its scope: two plants each have a line called `Line 1`, and `Lyon / Line 1` refers to one of them. See [Names](schemas.md#names).
- It owns its [items at actor](#item-at-actor) — the items it holds — and its [transformations](#transformation).
- It can belong to one [scope](#scope), the swim lane that contains it. A new actor takes the default scope of its type when none is given, per [Actor Creation](implementation.md#actor-creation).
- It can be at one [location](#location), through its optional `location` relation, which can change. Several actors can share a location.
- It can be part of one parent actor, its optional `parent_actor`: a workshop in a plant. The relation is a composition, can change over time, and has `child_actors` as inverse. An actor's domains are among those of its parent, and the parents of an actor never lead back to it, per the network rules `parent_actor_domains` and `parent_actor_acyclic`.

## Flow

*Definition.*

A **flow** connects a source [actor](#actor) to a destination actor, and moves, transmits or delivers an item from the first to the second: a transportation lane, a communication link, a money wire, a service provision.

- `source` and `destination` are mandatory; the item moves from source to destination.
- Its `item` is optional: a flow carries at most one [item](#item). The actions set it once and never change or remove it.
- A flow between an actor and one of its child actors, in either direction, carries an item: it is a transport inside the actor (`internal_flow_item`).
- Its [flow type](#typing) is optional and can change. Deleting a flow type keeps its flows, with no type. It says what the flow means, such as a delivery, a return or a disposal, which its item cannot say: one item moves in flows of opposite meaning, a drug delivered and then returned.
- A carried item belongs to the domain of the flow type (`flow_item_type_domain`).
- The domain of the flow type is among the domains of the source and of the destination, with or without an item (`flow_type_end_domain`).
- The item's domain is among the domains of the source and of the destination (`carried_item_domain`).
- Both ends hold the item through an [item at actor](#item-at-actor): what leaves the source and what reaches the destination is held there (`flow_ends_hold_item`).
- Its `bidirectional` flag is a boolean, `false` by default. When `true`, the item may move in both directions; when `false`, only from source to destination.
- It has no name. Its source, destination, item and route identify it (`flow_unique`): two flows that share all four, when the item and the route are set, are refused, and what else there is to say goes in its description; see [Names](schemas.md#names).
- Its `route` is optional: a flow travels on at most one [route](#route), which says how it travels. A flow keeps its `source` and `destination` on a route: on a round trip they say where the item is loaded and unloaded.

## Route

*Definition.*

A **route** says **how** flows travel, where a [flow](#flow) says **what** moves: a shuttle between two plants, a weekly round trip of a truck, an EDI link, a payment term. A **route type** is the category of transport or exchange: road, sea, air, rail, EDI, payment. A **route** is an instance that serves ordered stops with a schedule and lead times, and it has exactly one route type. A route type is named like the other [types](#typing), `route_type` as `actor_type` and `item_type`.

- Its `route_type` is mandatory and gives its [domain](#flow-domain), exactly one, as an `item_type` does: a route carries one domain.
- It has a name, a description and a `schedule`, a free text in one or more languages such as "every Monday" or "daily at 6:00". The format of a structured schedule is left open.
- It owns its ordered **stops**. A stop is an [actor](#actor), a `sequence` and the `lead_time` from the previous stop, an ISO 8601 duration such as `P2D`, unknown when empty. A point-to-point route has two stops; a round trip has more, and an actor may appear at several stops, so a round trip that returns to its start repeats it last (A, B, C, A). A stop may be the end of no flow, such as a transit hub, or a truck depot where a round trip starts and ends. Two consecutive stops make a **leg**.
- Its `bidirectional` flag, `false` by default, says that its stops are served in both orders, such as a shuttle between two plants. Each leg then has a lead time in each direction: the reverse lead time of a stop, from it back to the previous stop, equals its lead time unless given.
- A flow with a route has its source and destination among the stops of the route (`route_stops_hold_flow_ends`).
- The domain of the item of a flow with a route is the domain of the route type (`route_item_domain`).
- The domain of the flow type of a flow with a route is the domain of the route type (`route_flow_type_domain`), so a flow without an item travels only on routes of the domain of its type.
- The route **serves** the flow (`route_serves_flow`): a stop of the source comes before a stop of the destination, unless the route is bidirectional. A [bidirectional](#flow) flow is served in both directions: the route is bidirectional, or its stops also hold a stop of the destination before a stop of the source, as a round trip A, B, A does.
- A flow never gets a route implicitly: creating a flow creates no route. A route is created on its own, or from given flows that share their source and destination.

The **lead time of a flow** on its route is derived, never stored: the sum of the lead times of the legs from a stop of its source to a stop of its destination, along the first such path in the order of the stops. On a bidirectional route, when no stop of the destination follows a stop of the source, the path runs backwards through the reverse lead times. A bidirectional flow has a lead time in each direction. It is unknown when a leg of the path has no lead time. See [Lead Time Of A Flow](implementation.md#lead-time-of-a-flow).

## Item

*Definition.*

An **item** is what the network moves and holds: a product, a material, a message, an order, an invoice, a currency, a service unit.

At [scoping granularity](why-modelling-flows.md#scoping-granularity), an item is a family — a product family, a message type, a service offering — and not an individual reference such as a SKU.

- Its `item_type` is mandatory, can change, and gives its [domain](#flow-domain), exactly one.
- It is defined once in the network and referenced by every [item at actor](#item-at-actor), [flow](#flow) and [transformation](#transformation) that involves it.

## Typing

*Concept.*

Every [actor](#actor), [item](#item) and [transformation](#transformation) has a type, instance of `actor_type`, `item_type` or `transformation_type` respectively, a [route](#route) has a `route_type`, instance of `route_type`, and a [flow](#flow) may have a `type`, instance of `flow_type`. The type of an actor, an item or a transformation, and the route type of a route, is mandatory; the type of a flow is optional. Each can change.

A type, like a route type, is data: an instance with a name and a description, each in one or more languages, the description written for human and AI readers, per [Natural Language Capture](why-modelling-flows.md#natural-language-capture), and its [domains](#flow-domain) — exactly one for `item_type`, `route_type` and `flow_type`, one or more for `actor_type`, none for `transformation_type`. Adding a type adds an instance and leaves the model unchanged, which is what [Typed Vocabulary](why-modelling-flows.md#typed-vocabulary) requires. A transformation has no domain: the domain of each item it consumes or produces comes from that item.

A flow type also has a **direction**, which says how its flows run relative to the main stream of the network, so that a tool can tell them apart and lay them out:

| Direction | Meaning |
| --- | --- |
| `forward` (default) | Flows along the main stream, from suppliers to customers, such as a delivery |
| `same-level` | Flows between peers, such as with an overflow warehouse or a subcontractor |
| `reverse` | Reverse logistics: returns, recalls, disposal, empty packaging |

The direction says what the flows of a type mean. It is independent of the `bidirectional` flag of a [flow](#flow), which says whether the item may move both ways between its two ends, and no rule relates them.

An `actor_type` can name a `default_scope`: the [scope](#scope) given to an actor created with that type. It is optional, and an explicit scope overrides it.

Types and scopes are grouped in libraries. SCFLOW provides a base library for each domain; an industry vertical or a company provides its own library, which a network uses through CORE's `import`.

## Item At Actor

*Definition.*

An **item at actor** states that an [actor](#actor) holds an [item](#item): an inventory of products, a queue of orders, a cash balance, a backlog of service work.

- It is owned by its actor, and references its item; an actor holds a given item at most once.
- The item's domain is among the actor's domains.
- An item held by an actor cannot be deleted: the relation to the item is mandatory, so its deletion is restricted.

## Transformation

*Definition.*

A **transformation** states that an [actor](#actor) consumes items to produce other items: components assembled into a finished product, raw material processed into an intermediate, spare parts and technician hours turned into a maintenance intervention. It is the bill of materials (BOM) of the actor, generalized to every [domain](#flow-domain). It is an entity of the network in its own right, named like actors and flows.

- It is owned by its actor, where it takes place.
- It has a name that its author writes, with no default, unique among the transformations of its actor; see [Names](schemas.md#names).
- Its `transformation_type` is mandatory and set at creation, like the type of an actor or an item, per [Typing](#typing); it carries no domain.
- Its lines list the consumed items and the produced items.
- Each line references the [item at actor](#item-at-actor) it consumes or produces, held by the transformation's own actor. A transformation has at most one line for a given held item and role, per the rule `transformation_line_unique`.
- Consumed and produced items can belong to different domains, as long as each is among the actor's domains — which is how a service built on products is described, per [All Flow Domains](why-modelling-flows.md#all-flow-domains).

Transformations are what link the flows reaching an actor to the flows leaving it.

## Conversion

*Definition.*

A **conversion** states that an [actor](#actor) turns one [item](#item) into another: a raw material into a part, a part into a finished product, a request into a quote. It is the one-to-one counterpart of a [transformation](#transformation), which consumes and produces several items, and is flow-like: it goes from an item to an item as a flow goes from an actor to an actor.

- It is owned by its actor, where it takes place.
- It references a source item (`from_item`) and a target item (`to_item`); both are mandatory and set at creation, and neither changes afterwards.
- The domain of the source item and the domain of the target item are identical.
- It has no name: its actor, its source item and its target item identify it, and an actor has at most one conversion from an item to another (`conversion_unique`). It has an optional description, written in one or more languages; see [Names](schemas.md#names).

An item referenced by a conversion cannot be deleted: the relation to the item is mandatory, so its deletion is restricted.

## Scope

*Definition.*

A **scope** groups [actors](#actor) into a swim lane read on its own: sourcing, production, distribution, a region, a business unit. In the graph a scope is a lane that contains its actors.

- A scope is flat: it has no parent and no owner. It is an instance of the dataset, and a type library holds scopes beside its types.
- An actor belongs to at most one scope, through its `scope` relation. An actor type can name a default scope, per [Typing](#typing).
- A flow connecting actors of different scopes crosses their boundary.
- A scope may be put in a **group** of scopes (a region, a stage such as SOURCE, MAKE, DELIVER), with a **position in the group**. The group is the name its scopes share, an unlocalized string that is never shown as a label: it only says which scopes belong together. A group has no existence of its own: it exists while a scope carries its name, and a scope with an empty group is in none. The position starts at 1 and orders the scopes of a group; two scopes of a group may share a position, and then the name of the scope orders them. How a group is drawn is the business of the graph, not of the model.

## Location

*Definition.*

A **location** is a geographic place or site where [actors](#actor) operate: a port, a plant site, a city, a customer address.

- A location is a root of the dataset, with no owner and no parent.
- An actor is at most at one location, through its optional `location` relation, which can change. The relation is declared on the actor: the location declares none, and `actors` is generated on it. Several actors can share one location.
- Its position is a `latitude` and a `longitude` in WGS84, in decimal degrees. They are filled in later when unknown, for example by geocoding. The engine gives an unset number the value 0, so a latitude and a longitude that are both 0 mean that the location has no coordinates: the point (0, 0) lies in the open sea, where no site stands.
- It carries an address (`address`, `postal_code`, `city`), a `country_code` (ISO 3166-1 alpha-2), a `un_locode` (UN/LOCODE, five characters) and a `timezone` (IANA name, such as `Europe/Paris`). All are optional, and an empty text means that the value is unset.

## Note

*Definition.*

A **note** is a free-form annotation on one entity of the network: an actor, a flow, an item, a scope, a type, an item at actor, a transformation, a transformation line or a conversion.

- A note has an id and a `content` in Markdown, in one or more languages.
- It belongs to exactly one annotated entity, through its `annotated` relation, and is deleted with that entity.
- An entity carries any number of notes, none by default, listed by its generated `notes` relation.
- Notes take no part in the network rules.

## Flow Model Overview

*Figure.*

```mermaid
erDiagram
    ACTOR_TYPE ||--o{ ACTOR : "types"
    ITEM_TYPE ||--o{ ITEM : "types"
    TRANSFORMATION_TYPE ||--o{ TRANSFORMATION : "types"
    FLOW_TYPE |o--o{ FLOW : "types"
    ACTOR ||--o{ FLOW : "source of"
    ACTOR ||--o{ FLOW : "destination of"
    ACTOR ||--o{ ITEM_AT_ACTOR : "owns"
    ACTOR ||--o{ TRANSFORMATION : "owns"
    ITEM ||--o{ ITEM_AT_ACTOR : "held as"
    ITEM |o--o{ FLOW : "carried on"
    TRANSFORMATION ||--|{ TRANSFORMATION_LINE : "owns"
    ITEM_AT_ACTOR ||--o{ TRANSFORMATION_LINE : "consumed / produced as"
    ACTOR ||--o{ CONVERSION : "owns"
    ITEM ||--o{ CONVERSION : "converted from / to"
    SCOPE |o--o{ ACTOR : "groups"
    SCOPE |o--o{ ACTOR_TYPE : "default scope of"
    LOCATION |o--o{ ACTOR : "locates"
    ACTOR |o--o{ ACTOR : "contains"
    ROUTE_TYPE ||--o{ ROUTE : "categorizes"
    ROUTE ||--o{ ROUTE_STOP : "owns"
    ACTOR ||--o{ ROUTE_STOP : "stop of"
    ROUTE |o--o{ FLOW : "travels on"
```

## Domain Type Examples

*Example.*

Example types from the base libraries, by [domain](#flow-domain):

| Domain | Actor types | Item types |
| --- | --- | --- |
| `physical` | Customer, Supplier, Plant, Production line, Warehouse | Raw material, Component, Finished product |
| `information` | Organisation, Planner, ERP system, Customer portal | Message, Order, Invoice, Forecast |
| `financial` | Organisation, Bank, Financial institution | Currency, Value |
| `service` | Service provider, Technician, Resource | Service unit, Intervention |

Example flow types of the `physical` domain are Delivery (`forward`), Subcontracting (`same-level`), and Return and Disposal (`reverse`).

An actor type spanning several domains appears in each of them: a Customer is physical, information and financial; a Service provider is service and physical.
