# Implementation

## Schemas Package

*Implementation.*

The `@scfloworg/module-scflow-core` package of the `core` repository is the module `scflow:core`. Its manifest, `module.yaml` at the root of the package, is a [module manifest](../../../core/docs/spec/meta-model.md#module) and holds the whole module in one file:

- `name: scflow:core`, `namespace: scflow`, and `mcl: ^1.0`, the range of `mcl:core` it works with. It has no other dependency.
- `version`, the version of the module, always equal to the `version` of the `package.json` of the package. A test checks it.
- `title: Supply chain flow`.
- `scalar_types` and `schemas`: the schemas and scalar types of section 3, THE SCHEMAS. Section 3 states the model and takes precedence: the manifest follows it, and a difference between the two is a defect of the manifest.
- `actions`: one declaration for each action of `ACTIONS` (see the topic `scflow/actions`), with its `id`, `title`, `description`, `kind`, `destructive`, `writes` and `parameters`. A test checks that the declarations and `ACTIONS` agree.
- `skills`: the [skills](../../../core/docs/spec/meta-model.md#skill) of the module, methods in Markdown that an AI assistant loads on demand. `scflow/image_to_model` gives the method to create or refine a model from a diagram, a sketch or a photograph; its body is `skills/image-to-model.md`. `scflow/physical_to_information_flows` gives the method to derive, from the physical network, the decoupling point and MTS, ATO, MTO or ETO situation of each product family and the information actors and flows of its forecast-to-stock, order-to-cash (up to the invoice) and S&OP processes, each process a scope; it stops on a model with no physical flow, and its body is `skills/physical-to-information-flows.md`. The `uses` of each skill names the actions it cites. A test runs `checkSkillCitations` of `@scfloworg/environment` on every skill, so a body cites only actions of its `uses`, and schema processing checks that each of them is an action of the module.

The code of the module is its bundle, `dist/module.js`, built by `buildModule` of [`@scfloworg/module`](../../../module/docs/module-packages.md) from `src/module.ts`. Its default export is `defineModule(manifest, { actions, skills })`, which gives the body of each action of `ACTIONS` under its name, the part of its id after the slash, so every declared action has its code, and the text of the file of each skill under its name. The package publishes `module.yaml` and `skills/` with its bundle, and exports the bundle and its declaration as `@scfloworg/module-scflow-core/module` (the convention of [`@scfloworg/module`](../../../module/docs/module-packages.md), Build the bundle), so a host that bundles its modules, such as a browser, imports the module and gives it to `modules.install` of its environment. A body takes the context of the action, which an environment gives (see [`@scfloworg/environment`](../../../environment/docs/environment.md)), and its parameters, and calls `run(params, context)` of the action. The package imports only types from `@scfloworg/core`: the bundle holds no copy of the engine, and the host gives the one instance. `modules.load` of `@scfloworg/module/host` loads the module from the folder of the package; a test builds the bundle, loads it and runs a body on a dataset, and the acceptance of phase B loads it in an environment beside a module with a facet. The module has no migration: version 2.0.0 renames `display_name` to `name` in every schema, declares `name_scope`, and removes the name of `flow` and `conversion`, names the instance of transport `route` (with `route_stop` and the `route` of a flow, formerly `mode`) and its category `route_type`, as the other types are named (formerly `mode_type`, then `mode`), adds `flow_type` and the optional `type` of a flow, an incompatible change for which no migration is written, since only samples exist and they are regenerated; version 1.1.0 adds rules and defaults, a compatible change refused only for a dataset that breaks a rule, version 1.2.0 adds the skill `scflow/image_to_model`, which changes no schema, and version 1.3.0 adds the transport of flows (a category, its instance with its stops, and the optional instance of a flow), a compatible change that every existing dataset satisfies, since no flow has one.

A script of the package compiles the `scalar_types` and the `schemas` of the manifest to `src/schemas.generated.ts` before each build and each test run; the generated file is not versioned. The package exports the result as `SCHEMAS`. The tests of the schemas and of the actions run on a dataset of an environment that installs the module, as every caller does.

The manifest holds the scalar types `flow_domain`, `flow_direction`, `transformation_role`, `tag`, `latitude`, `longitude`, `country_code`, `un_locode` and `lead_time`, then the schemas in the order of section 3: `annotable`, `note`, `actor_type`, `item_type`, `flow_type`, `actor`, `flow`, `item`, `item_at_actor`, `transformation_type`, `transformation`, `transformation_line`, `conversion`, `route_type`, `route`, `route_stop`, `scope`, `location`.

## SCFLOW Model Contribution

*Implementation.*

`scflow-plugin`, a plugin of the `scflow-plugins` repository (see Repository Structure), installs the module `scflow:core` in its environment with `modules.install` at start-up, and a document embeds the module when it uses it.

## Type Libraries

*Implementation.*

A type library is a dataset holding `actor_type`, `item_type`, `flow_type`, `transformation_type` and `scope` instances and no other data. SCFLOW provides one base library per [flow domain](flow-model.md#flow-domain), holding the types of [Domain Type Examples](flow-model.md#domain-type-examples); an industry vertical or a company provides its own library of the same shape. A network imports the libraries it uses through [Import](../../../core/docs/spec/meta-model.md#import): imported types are read-only in the network, and its actors and items reference them through their ordinary `type` relation. Imported scopes are read-only too, and an actor references one through its ordinary `scope` relation. The `default_scope` of a library's actor type is a scope of the same library.

## Network Rules

*Feature.*

A flow network satisfies these eighteen rules. Each is declared on the schema named in the table, as a [rule](../../../core/docs/spec/meta-model.md#rules) of the module, in [the schemas](schemas.md):

| Rule | Statement | Declaration | Stated in |
| --- | --- | --- | --- |
| `held_item_domain` | An item at actor's item domain is among the actor's domains | `checks` of `item_at_actor` | [Item At Actor](flow-model.md#item-at-actor) |
| `held_item_unique` | An actor holds a given item at most once | `unique` of `item_at_actor` | [Item At Actor](flow-model.md#item-at-actor) |
| `flow_unique` | Two flows never share their source, destination, item and route, when the item and the route are set | `unique` of `flow` | [Flow](flow-model.md#flow) |
| `carried_item_domain` | The domain of the item of a flow is among the domains of the flow's source and of its destination | `checks` of `flow` | [Flow](flow-model.md#flow) |
| `flow_ends_hold_item` | The source and the destination of a flow hold the item it carries | `checks` of `flow`, with `exists` | [Flow](flow-model.md#flow) |
| `internal_flow_item` | A flow between an actor and one of its child actors carries an item | `checks` of `flow` | [Flow](flow-model.md#flow) |
| `transformation_line_actor` | A transformation line's held item belongs to the transformation's actor | `checks` of `transformation_line` | [Transformation](flow-model.md#transformation) |
| `transformation_line_unique` | A transformation has at most one line for a given held item and role | `unique` of `transformation_line` | [Transformation](flow-model.md#transformation) |
| `parent_actor_acyclic` | The parents of an actor never lead back to the actor | `acyclic` on `parent_actor` of `actor` | [Actor](flow-model.md#actor) |
| `parent_actor_domains` | An actor's domains are among the domains of its parent | `checks` of `actor` | [Actor](flow-model.md#actor) |
| `conversion_unique` | An actor has at most one conversion from an item to another | `unique` of `conversion` | [Conversion](flow-model.md#conversion) |
| `conversion_item_domain` | The two items of a conversion have the same domain | `checks` of `conversion` | [Conversion](flow-model.md#conversion) |
| `route_stops_hold_flow_ends` | The source and the destination of a flow with a route are stops of that route | `checks` of `flow`, with `exists` | [Route](flow-model.md#route) |
| `route_item_domain` | The domain of the item of a flow with a route is the domain of the route type | `checks` of `flow` | [Route](flow-model.md#route) |
| `flow_item_type_domain` | The item of a flow with a flow type belongs to the domain of the type | `checks` of `flow` | [Flow](flow-model.md#flow) |
| `flow_type_end_domain` | The domain of the flow type of a flow is among the domains of the flow's source and of its destination | `checks` of `flow` | [Flow](flow-model.md#flow) |
| `route_flow_type_domain` | The domain of the flow type of a flow with a route is the domain of the route type | `checks` of `flow` | [Route](flow-model.md#route) |
| `route_stop_sequence_unique` | Two stops of a route never share a sequence | `unique` of `route_stop` | [Route](flow-model.md#route) |

Each of these rules, except the `acyclic` one, declares a `message` that says in words what it requires, e.g. "the domain of the flow type must be among the domains of the types of both actors" for `flow_type_end_domain`. A refusal gives that message and names the instances at fault by their names or by what they link: for a flow, its source, its destination and its flow type, as in `the "scflow.flow" with source "Plant", destination "System", type "Drug" breaks the rule "flow_type_end_domain": ...` (see [Rules](../../../core/docs/spec/meta-model.md#rules)).

The `acyclic` rule is reported under the name of its property, `parent_actor`, as every `acyclic` relation is. The other constraints of the same kind, `set_once` on the `item` of a `flow` and `on_delete: confirm` on the relations whose target cannot be deleted without consent, are stated on their property in [the schemas](schemas.md).

## Route Rules Checked By Actions

*Feature.*

The rule `route_serves_flow` of [Route](flow-model.md#route) compares the positions of two stops among the stops of a route. A [rule](../../../core/docs/spec/meta-model.md#rules) has no quantifier over instances, so it cannot be declared: the actions that can break it check it before they return, and throw an error that names `route_serves_flow`, the route and the flow, which rolls the whole action back. They are the actions that write the route of a flow (`scflow/create_flow`, `scflow/set_flow_route`, `scflow/create_route_from_flows`), the `bidirectional` flag of a flow or a route (`scflow/update_flow`, `scflow/update_route`) and the order of the stops (`scflow/update_route_stop`, `scflow/remove_route_stop`). Adding a stop keeps the order of the others, and deleting an actor deletes the flows that end at it with its stops, so neither breaks the rule. A write command run below the actions is not checked against it.

A stop that is the end of no flow of its route, such as a transit hub or a truck depot where a round trip starts and ends, is a normal case: no rule applies to it, and `scflow/inspect_route` lists it among the `stops_without_flow` of the route.

## Lead Time Of A Flow

*Feature.*

`@scfloworg/module-scflow-core` exports `leadTimeOnRoute(stops, from, to, bidirectional)`, a pure function, and `addDurations(durations)`. The stops are the stops of one route, `{actor, lead_time?, reverse_lead_time?}` in the order of their `sequence`.

- The forward path starts at the first stop of `from` that some later stop of `to` follows, and ends at the first such stop of `to`. Its lead time is the sum of the `lead_time` of the stops after its start, up to and including its end.
- When there is no forward path and `bidirectional` is true, the backward path is the forward path of the stops taken in reverse order: it starts at the last stop of `from` that some earlier stop of `to` precedes, and ends at the nearest such stop of `to` before it. Its lead time is the sum of the `reverse_lead_time` of the stops after its end, up to and including its start, each defaulting to its `lead_time`.
- The function returns the path, its direction and its lead time, or `undefined` when there is no path. The lead time is `null` when a leg of the path has no lead time.

Durations are ISO 8601 durations, the pattern of the `duration` scalar type of `mcl:core`, which the scalar type [`lead_time`](schemas.md#lead_time) of a stop follows; an empty lead time is unknown. `addDurations` sums them component by component, years with years and hours with hours, so a sum needs no calendar: `P1D` plus `PT12H` is `P1DT12H`, and two `PT45M` make `PT90M`. The sum of no duration is `PT0S`.

The lead time of a flow is the result for its source and its destination on its route; a bidirectional flow also has the result for its destination and its source. `scflow/inspect_route` returns both for every flow of a route. A flow whose route serves it always has a path, per `route_serves_flow`.

## Network Check

*Feature.*

There is no separate check of a network: the engine enforces the [Network Rules](#network-rules). Every rule refuses at the end of any transaction, with no severity levels, and is re-evaluated when a path it reads changes, so changing the type of an actor or of an item is refused when an item it holds or carries no longer fits. A breach refuses the whole transaction with `rule_violation`, whose details give the name of the rule, the schema and the key of the instance.

A network is therefore valid after every transaction, and a change that goes through an invalid state is made in one transaction: in a batch, for example, an actor takes a parent and the flow to that parent receives its item together. A rule refuses and never creates, so `scflow/create_flow` and `scflow/set_flow_item` write the holdings that `flow_ends_hold_item` requires.

An [upgrade](../../../core/docs/spec/meta-model.md#model-upgrade) of a dataset that breaks a rule is refused with the list of the instances at fault. Until the [write limit](../../../core/docs/spec/meta-model.md#action) is enforced outside actions, a write command run outside an action is checked against the rules, but is not refused for being outside an action.

## Common Flow Domains And Flow Creation

*Feature.*

`@scfloworg/module-scflow-core` exports three functions, each taking `(mcl, locator, input)`.

`getCommonFlowDomains` reads without writing and takes `{source, destination}`. It returns the [flow domains](flow-model.md#flow-domain) common to the two actors, the intersection of the `domains` of their types. An interface uses it to refuse a drag and drop when the list is empty.

`createFlow` takes `{source, destination, type?, item?, route?, description?, bidirectional?, tags?}`, creates one [flow](flow-model.md#flow) and returns it. `bidirectional` is `false` when absent. With an item, it creates the holdings of `setFlowItem` first.

`setFlowItem` takes `{flow, item}` and sets the item of a flow. It creates the [item at actor](flow-model.md#item-at-actor) that either end lacks, which `flow_ends_hold_item` requires. The `item` of a flow is `set_once`: another item is refused with `constraint_violation`, and the same item changes nothing.

The functions throw when an actor, a flow or an item does not exist. The engine refuses a breach of a rule, per [Network Check](#network-check).

## Actor Creation

*Feature.*

`@scfloworg/module-scflow-core` exports `createActor(mcl, locator, {name, type, scope?, location?, description?})`, which creates one [actor](flow-model.md#actor) and returns it.

The actor takes the `scope` of the input when the input gives one. Otherwise it takes the `default_scope` of its type, through the `default_value` of its `scope` property, and no scope when the type has none. An explicit scope always overrides the default. The function throws when the type or the given scope does not exist.

The actor is at the [location](flow-model.md#location) of the input when the input gives one, and at none otherwise: a location has no default. The function throws when the given location does not exist.

The default is applied at creation: a later change of the `default_scope` of a type leaves the existing actors unchanged.
