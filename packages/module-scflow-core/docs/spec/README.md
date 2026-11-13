# SCFLOW model specification

The supply chain flow model: why flows are modelled, the concepts and schemas that describe them, and how they are implemented on the CORE model.

This specification is normative: the code and `module.yaml` follow it. The language it is written in is specified in [`@scfloworg/core`](../../../core/docs/spec/README.md).

## [Why modelling supply chain flows](why-modelling-flows.md)

- [Scoping Gap](why-modelling-flows.md#scoping-gap): Scoping a supply chain network needs a map between throwaway static drawings and rigid network-design software
- [All Flow Domains](why-modelling-flows.md#all-flow-domains): Physical, information, financial and service flows are captured on equal footing, as native flow domains
- [Cross-Functional Dialogue](why-modelling-flows.md#cross-functional-dialogue): One map supports dialogue between supply chain, operations, IT, finance and CSR
- [Durable Flow Map](why-modelling-flows.md#durable-flow-map): A flow map outlives the tool and the mission that produced it: open, auditable, reusable
- [Scoping Granularity](why-modelling-flows.md#scoping-granularity): The model works at scoping granularity, a macro network of up to several hundred actors, not operational detail
- [Hierarchical Networks](why-modelling-flows.md#hierarchical-networks): An actor can open into a finer network held by another dataset, and a network groups its actors into swim lanes
- [Typed Vocabulary](why-modelling-flows.md#typed-vocabulary): Every actor and item has a type from a shared, extensible vocabulary (industry verticals, company-specific types)
- [Cross-Functional Overlays](why-modelling-flows.md#cross-functional-overlays): Transverse dimensions (risk, carbon, tariffs, working capital) can be projected onto the network without changing the core
- [Representation Independence](why-modelling-flows.md#representation-independence): Business content is complete on its own; representations (map, Sankey, tiering) reference it, never the reverse
- [Downstream Analysis Input](why-modelling-flows.md#downstream-analysis-input): The map is a reliable input for downstream sizing and analysis, such as buffer positioning or DDMRP, whatever the methodology
- [Natural Language Capture](why-modelling-flows.md#natural-language-capture): The vocabulary is described well enough that a network can be built from a natural-language workshop description

## [The flow model](flow-model.md)

- [Flow Network](flow-model.md#flow-network): A network describes items moving between actors on flows
- [Flow Domain](flow-model.md#flow-domain): The four domains: physical, information, financial, service
- [Actor](flow-model.md#actor): Where items are consumed, created, transformed, stored or queued; belongs to one or more domains
- [Flow](flow-model.md#flow): Connects a source actor to a destination actor to move one optional item; has no domain
- [Item](flow-model.md#item): What moves on a flow and is held at an actor; exactly one domain; a family at scoping granularity
- [Typing](flow-model.md#typing): Every actor, item and transformation has a mandatory type, which can change and carries its description and, except for a transformation, its domains
- [Item At Actor](flow-model.md#item-at-actor): An item held at an actor: inventory, waiting queue, cash, work in progress
- [Transformation](flow-model.md#transformation): At an actor, the items consumed and produced: a bill of materials generalized to every domain
- [Conversion](flow-model.md#conversion): An actor turns one item into another item of the same domain; the one-to-one counterpart of a transformation
- [Scope](flow-model.md#scope): A flat grouping of actors, a swim lane of the graph; a scope has no parent and no owner
- [Location](flow-model.md#location): A geographic place or site where actors operate; shared by any number of actors
- [Note](flow-model.md#note): A free-form annotation on any entity of the network, owned by it and written in one or more languages
- [Flow Model Overview](flow-model.md#flow-model-overview): ER diagram of the flow model concepts
- [Domain Type Examples](flow-model.md#domain-type-examples): Example actor and item types in each flow domain

## [The schemas](schemas.md)

- [Flow Model ER Diagram](schemas.md#flow-model-er-diagram): ER diagram of the flow model schemas, their properties and relations
- [flow_domain](schemas.md#flow_domain): The scalar type of a flow domain
- [transformation_role](schemas.md#transformation_role): The scalar type telling a consumed transformation line from a produced one
- [tag](schemas.md#tag): The scalar type of a free-form tag, a string with no constraint
- [latitude](schemas.md#latitude): The scalar type of a latitude in degrees, WGS84
- [longitude](schemas.md#longitude): The scalar type of a longitude in degrees, WGS84
- [country_code](schemas.md#country_code): The scalar type of an ISO 3166-1 alpha-2 country code
- [un_locode](schemas.md#un_locode): The scalar type of a UN/LOCODE, five characters
- [annotable](schemas.md#annotable): The base schema of every SCFLOW entity, which owns the notes of its instances
- [note](schemas.md#note): A free-form annotation of one entity, written in one or more languages
- [actor_type](schemas.md#actor_type): A type of actor, with the flow domains it belongs to and an optional default scope
- [item_type](schemas.md#item_type): A type of item, with the one flow domain it belongs to
- [actor](schemas.md#actor): A place in the network where items are held, consumed, produced or queued
- [flow](schemas.md#flow): A connection moving one optional item from a source actor to a destination actor
- [item](schemas.md#item): A family of things the network moves and holds
- [item_at_actor](schemas.md#item_at_actor): An item held at an actor
- [transformation_type](schemas.md#transformation_type): A type of transformation, with no flow domain
- [transformation](schemas.md#transformation): A transformation of consumed items into produced items at an actor
- [transformation_line](schemas.md#transformation_line): One item consumed or produced by a transformation
- [conversion](schemas.md#conversion): A conversion of one item into another item at an actor
- [scope](schemas.md#scope): A flat grouping of actors, a swim lane of the graph
- [location](schemas.md#location): A geographic place or site where actors operate

## [Implementation](implementation.md)

- [Schemas Package](implementation.md#schemas-package): `@scfloworg/module-scflow-core` is the module `scflow:core`, declared in its manifest `module.yaml`; the schemas are compiled to TypeScript at build time and exported as `SCHEMAS`
- [SCFLOW Model Contribution](implementation.md#scflow-model-contribution): scflow-plugin installs the module `scflow:core` in its environment.
- [Type Libraries](implementation.md#type-libraries): Type libraries are datasets of actor, item and transformation type instances and scopes, imported by a network through CORE's import
- [Network Rules](implementation.md#network-rules): The ten rules a network satisfies, each declared on a schema with a stable name reported in `rule_violation`
- [Network Check](implementation.md#network-check): The engine refuses a breach of a network rule at the end of any transaction; there is no separate check
- [Common Flow Domains And Flow Creation](implementation.md#common-flow-domains-and-flow-creation): getCommonFlowDomains lists the flow domains common to two actors, and createFlow creates one flow between them
- [Actor Creation](implementation.md#actor-creation): createActor creates an actor and gives it the default scope of its type when no scope is given
