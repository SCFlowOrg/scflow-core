# Implementation

## Schemas Package

*Implementation.*

The `@scfloworg/scflow-core` package of the `core` repository is the module `scflow:core`. Its manifest, `module.yaml` at the root of the package, is a [module manifest](../../../core/docs/spec/meta-model.md#module) and holds the whole module in one file:

- `name: scflow:core`, `namespace: scflow`, and `mcl: ^1.0`, the range of `mcl:core` it works with. It has no other dependency.
- `version`, the version of the module, always equal to the `version` of the `package.json` of the package. A test checks it.
- `title: Supply chain flow`.
- `scalar_types` and `schemas`: the schemas and scalar types of section 3, THE SCHEMAS. Section 3 states the model and takes precedence: the manifest follows it, and a difference between the two is a defect of the manifest.
- `actions`: one declaration for each action of `ACTIONS` (see `docs/actions.md`), with its `id`, `title`, `description` and `kind`. A test checks that the declarations and `ACTIONS` agree.

The code of the module is its bundle, `dist/module.js`, built by `buildModule` of [`@scfloworg/module`](../../../module/docs/module-packages.md) from `src/module.ts`. Its default export is `defineModule(manifest, { actions })`, which gives the body of each action of `ACTIONS` under its name, the part of its id after the slash, so every declared action has its code. A body takes the context of the action, which an environment gives (see [`@scfloworg/environment`](../../../environment/docs/environment.md)), and its parameters, and runs the `execute` of the action with the context as its `MclAccess` and the locator of the context. The package imports only types from `@scfloworg/core`: the bundle holds no copy of the engine, and the host gives the one instance. `modules.load` of `@scfloworg/module/host` loads the module from the folder of the package; a test builds the bundle, loads it and runs a body on a dataset, and the acceptance of phase B loads it in an environment beside a module with a facet. The module has no migration yet.

A script of the package compiles the `scalar_types` and the `schemas` of the manifest to `src/schemas.generated.ts` before each build and each test run; the generated file is not versioned. The package exports the result as `SCHEMAS`, shaped as the `SchemaPackage` of `@scfloworg/core-plugin-core`, which `scflow-plugin` passes to `upgradeModel` (part `model_contribution`) and tests pass to `createTestDocument`.

The manifest holds the scalar types `flow_domain`, `transformation_role`, `tag`, `latitude`, `longitude`, `country_code` and `un_locode`, then the schemas in the order of section 3: `annotable`, `note`, `actor_type`, `item_type`, `actor`, `flow`, `item`, `item_at_actor`, `transformation_type`, `transformation`, `transformation_line`, `conversion`, `scope`, `location`.

## SCFLOW Model Contribution

*Implementation.*

`scflow-plugin`, a plugin of the `scflow-plugins` repository (see Repository Structure), is built on core-plugin (`dependsOn: ["core-plugin"]`). In `setup()` it calls `upgradeModel` once with the schemas and scalar types of section 3, THE SCHEMAS, per Accessing MCL And Extending The Built-in Model. They join the built-in dataset of the area: every network dataset sees them without holding a copy, and a network's dump names them in its built-in entry. A network dataset holds instances only — its actors, flows, items, transformations and scopes.

## Type Libraries

*Implementation.*

A type library is a dataset holding `actor_type`, `item_type`, `transformation_type` and `scope` instances and no other data. SCFLOW provides one base library per [flow domain](flow-model.md#flow-domain), holding the types of [Domain Type Examples](flow-model.md#domain-type-examples); an industry vertical or a company provides its own library of the same shape. A network imports the libraries it uses through [Import](../../../core/docs/spec/meta-model.md#import): imported types are read-only in the network, and its actors and items reference them through their ordinary `type` relation. Imported scopes are read-only too, and an actor references one through its ordinary `scope` relation. The `default_scope` of a library's actor type is a scope of the same library.

## Network Rules

*Feature.*

CORE constraints do not express rules comparing two instances. A flow network satisfies these nine rules in addition to them:

| Rule | Statement | Stated in |
| --- | --- | --- |
| `held_item_domain` | An item at actor's item domain is among the actor's domains | [Item At Actor](flow-model.md#item-at-actor) |
| `held_item_unique` | An actor holds a given item at most once | [Item At Actor](flow-model.md#item-at-actor) |
| `carried_item_domain` | The domain of the item of a flow is among the domains of the flow's source and of its destination | [Flow](flow-model.md#flow) |
| `flow_ends_hold_item` | The source and the destination of a flow hold the item it carries | [Flow](flow-model.md#flow) |
| `internal_flow_item` | A flow between an actor and one of its child actors carries an item | [Flow](flow-model.md#flow) |
| `transformation_line_actor` | A transformation line's held item belongs to the transformation's actor | [Transformation](flow-model.md#transformation) |
| `parent_actor_acyclic` | The parents of an actor never lead back to the actor | [Actor](flow-model.md#actor) |
| `parent_actor_domains` | An actor's domains are among the domains of its parent | [Actor](flow-model.md#actor) |
| `conversion_item_domain` | The two items of a conversion have the same domain | [Conversion](flow-model.md#conversion) |

## Network Check

*Implementation.*

`scflow-plugin` provides `checkNetwork`, which evaluates every rule of [Network Rules](#network-rules) against a dataset: it reads instances through MCL queries, compares them in code, and returns a list of violations `{rule, schema, key, message}`, empty for a valid network. The plugin exposes it as a command listing the violations with a link to each instance.

The check runs on demand and never rejects a write. A network is captured step by step during a workshop, and some rules hold only once several instances exist: an actor takes a parent after a flow links it to its future child, so `internal_flow_item` fails in between, and a change of type can break `held_item_domain` or `carried_item_domain`.

## Common Flow Domains And Flow Creation

*Feature.*

`@scfloworg/scflow-core` exports three functions, each taking `(mcl, locator, input)`.

`getCommonFlowDomains` reads without writing and takes `{source, destination}`. It returns the [flow domains](flow-model.md#flow-domain) common to the two actors, the intersection of the `domains` of their types. An interface uses it to refuse a drag and drop when the list is empty.

`createFlow` takes `{source, destination, item?, display_name?, description?, bidirectional?, tags?}`, creates one [flow](flow-model.md#flow) and returns it. `bidirectional` is `false` when absent. It throws when the flow joins an actor and one of its child actors and gives no item (`internal_flow_item`). With an item, it applies the checks and the holdings of `setFlowItem`.

`setFlowItem` takes `{flow, item}` and sets the item of a flow that carries none. It throws when the flow carries another item, and when the item's domain is not among the domains of the source and of the destination (`carried_item_domain`). It creates the [item at actor](flow-model.md#item-at-actor) that either end lacks (`flow_ends_hold_item`).

The functions throw when an actor, a flow or an item does not exist. Network Check reports the other rules.

## Actor Creation

*Feature.*

`@scfloworg/scflow-core` exports `createActor(mcl, locator, {display_name, type, scope?, location?, description?})`, which creates one [actor](flow-model.md#actor) and returns it.

The actor takes the `scope` of the input when the input gives one. Otherwise it takes the `default_scope` of its type, and no scope when the type has none. An explicit scope always overrides the default. The function throws when the type or the given scope does not exist.

The actor is at the [location](flow-model.md#location) of the input when the input gives one, and at none otherwise: a location has no default. The function throws when the given location does not exist.

The default is applied at creation: a later change of the `default_scope` of a type leaves the existing actors unchanged.
