# Why modelling supply chain flows

## Scoping Gap

*Requirement.*

Scoping a supply chain network — for a transformation project, a diagnostic, a merger or acquisition, a master plan — needs a map of its flows. Two kinds of tool are at hand, and neither fits the scoping phase:

- **Static drawings** (slides, whiteboards) are fast and visual in a workshop, but carry no structure: every change of assumption means redrawing by hand, and the drawing says nothing a tool can check or reuse.
- **Network-design software** is detailed and rigorous, but needs months of data preparation before the first diagram, and leaves strategic decision-makers out of its construction.

The SCFLOW model fills the space between them: a structured description of the network, precise enough to be checked and reused, light enough to be built and adjusted live in a workshop.

## All Flow Domains

*Requirement.*

A supply chain moves more than goods. Scoping is the phase where every constraint has to be on the table, and each of four flow domains carries constraints of its own:

- **Physical** — products moved, stored, transformed.
- **Information** — orders, messages, data exchanged between organisations, people and IT systems.
- **Financial** — payments, transfers, working capital tied up in the network.
- **Service** — service units delivered by providers and resources.

The model treats all four as native domains, described with the same constructs and the same level of detail. Service flows in particular are a first-class domain: every company sells services around its products or products around its services, and products increasingly turn into services — hours on the road sold instead of tires. Service capacity is a sizing constraint of its own and a direct measure of delivered value, which a model built around physical flows alone cannot express.

## Cross-Functional Dialogue

*Requirement.*

Scoping decisions involve supply chain, operations, IT, finance and CSR together. Each function reads the network through its own flows and constraints, and the decisions that matter sit where those flows meet — an order triggering a shipment, a shipment triggering a payment, a service depending on a spare part.

The model describes all [flow domains](#all-flow-domains) in one network, so every function discusses the same map, and the links between domains are part of the description.

## Durable Flow Map

*Requirement.*

A flow map produced during a mission is an asset for the organisation that commissioned it. It stays readable, checkable and reusable after the mission ends and independently of the tool that produced it: its content is described by an open model, so any tool implementing the model reads it, and a later project starts from it.

This durability is also how the model spreads: every map delivered at the end of a mission carries the model to a new organisation.

## Scoping Granularity

*Requirement.*

The model describes a network at the granularity scoping decisions are made: sites, organisations, systems, main flows and item families — a macro network of up to several hundred actors. Operational detail, such as individual transactions, schedules or item-level master data, belongs to the operational systems the map is scoped against.

Finer detail remains reachable where a decision needs it, through [Hierarchical Networks](#hierarchical-networks).

## Hierarchical Networks

*Requirement.*

A network is read at several levels. An actor that is a single box at one level — a plant, a distribution centre, an IT landscape — opens into a finer network of its own at the next level: production lines, storage zones, applications.

The detail of an actor is a network of another dataset, which the actor references. The schemas of this model do not include that reference. Within a network, [scopes](flow-model.md#scope) group actors into flat swim lanes, each readable on its own.

## Typed Vocabulary

*Requirement.*

Every actor and item in a network has a type — Customer, Plant, ERP system; Finished product, Order, Service unit. Types give a network its business meaning, make maps comparable across projects, and let a tool check that a network is consistent.

The vocabulary of types is shared and extensible. The model provides a base vocabulary for each [flow domain](#all-flow-domains); industry verticals (cold chain, online sales, aerospace) and individual companies add their own types in libraries, without changing the model itself.

## Cross-Functional Overlays

*Requirement.*

Some dimensions cut across every flow domain: supply risk, carbon footprint, customs tariffs and cross-border constraints, working capital tied up in stock and transit. They shape any credible target network, and each is analysed on top of the same map.

The model lets such a dimension attach its own data to actors, flows and items, as an overlay on the network. The core model stays limited to the universal description of flows, and each overlay is added only where a project needs it.

## Representation Independence

*Requirement.*

The same network is shown in different ways depending on the question asked: a geographic map, a Sankey diagram of volumes, a tiering of suppliers, a diagram of one flow domain. The business content of the network — its actors, flows and items — is complete and meaningful on its own, whatever representation shows it.

Representations reference the business content and never the reverse: a network carries as many representations as there are analysis needs, and adding, changing or removing one leaves the business content untouched.

## Downstream Analysis Input

*Requirement.*

A map built at scoping time feeds the analyses that follow it: buffer positioning, capacity sizing, simulation, optimisation. DDMRP is one such methodology among others. The model carries what these analyses need from the network — which actors hold which items, which flows connect them — in a structured form a tool reads directly.

The model stays independent of any particular methodology: a methodology's own concepts are added on top of the network, the same way as a [cross-functional overlay](#cross-functional-overlays).

## Natural Language Capture

*Requirement.*

Flows are discovered in workshops, as notes, recordings or whiteboard sketches, in the words of the people who run them. A network is built from such a description: an AI assistant or a user translates it into actors, flows and items.

This requires every construct and every type of the model to carry a description a human or an AI reads without outside documentation, and the vocabulary to stay close to the words practitioners already use.
