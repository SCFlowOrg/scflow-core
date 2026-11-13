# @scfloworg/scflow-core

Business package of the supply chain flow model: MCL schemas and pure domain logic.
The model is stated in its [specification](docs/spec/README.md).

## Module

The package is the module `scflow:core`, namespace `scflow`. Its manifest, `module.yaml`, holds
its identity, its scalar types, its schemas and the declarations of its actions, and is read by
`readModuleManifest` of `@scfloworg/core`. Its `version` is always the `version` of
`package.json`, and its actions agree with `ACTIONS`: `tests/module.test.ts` checks both.

Its code is one bundle, `dist/module.js`, built from `src/module.ts` by `buildModule` of
`@scfloworg/module` (see its [docs](../module/docs/module-packages.md)): the default export
`defineModule(manifest, { actions, skills })` gives each action of `ACTIONS` as a body that calls its `run(params, context)`,
and the text of each skill file.
The package imports only types from `@scfloworg/core`, so the bundle holds no copy of the
engine. A host loads the module with `modules.load(folder)` of `@scfloworg/module/host`;
`tests/bundle.test.ts` builds, checks and loads the bundle. `tsc -b` leaves `src/module.ts` out,
since it imports `module.yaml`; `tsconfig.module.json` type-checks it.

## Skills

The module declares its skills in `module.yaml`, each with its body in `skills/`:
`scflow/image_to_model` is the method to create or refine a model from a diagram, a sketch or a
photograph; `scflow/physical_to_information_flows` derives, from the physical network, the
MTS or MTO situation of each product family and the actors and information flows of its
forecast-to-stock, order-to-cash and S&OP processes, one scope per process.
`tests/skills.test.ts` checks that every action id a body cites is in the `uses` of
its skill, and that the skill is offered by `use_skill` only with those actions.

## Exports

- `SCHEMAS`: the scalar types and schemas, compiled from `module.yaml`.
- `createActor(mcl, locator, { display_name, type, scope?, location?, description?, parent_actor?, tags? })`: creates an
  actor and returns it. The actor takes `scope` when given, otherwise the `default_scope`
  of its type, and no scope when the type has none; the default is applied at creation
  only. It is at `location` when given and at none otherwise. It throws when the type, the
  given scope or the given location does not exist.
- `getCommonFlowDomains(mcl, locator, { source, destination })`: read-only; returns the flow
  domains common to the two actors. An interface uses it to accept or refuse a drag and
  drop: an empty list refuses it. It throws when an actor does not exist.
- `createFlow(mcl, locator, { source, destination, item?, bidirectional?, display_name?, description?, tags? })`:
  creates one flow from `source` to `destination` and returns it. A flow has no domain, so
  it does not check the domains of the actors. With an `item`, the call creates the `item_at_actor`
  that the source and the destination lack. It throws when an actor or the item does not exist, or
  when a rule of the network is broken.
- `setFlowItem(mcl, locator, { flow, item })`: sets the item of a flow, with the same holdings as
  `createFlow`. The item of a flow is `set_once`: another item is refused, and the same item changes nothing.
- `ACTIONS`: the model actions of the package, each with its declaration and its body
  `run(params, context)`, for UIs, AI assistants and macros. An environment runs them through
  the module. The package exports
  `create_actor`, `update_actor`, `delete_actor`, `create_actor_type`, `create_scope`,
  `create_flow`, `update_flow`, `set_flow_item`, `delete_flow`, `create_item_type`, `create_item`, `update_item`, `hold_item`,
  `release_held_item`, `create_transformation_type`,
  `create_transformation`, `connect_transformation_line`, `define_process`, `create_conversion`, `update_conversion`, `add_tags`, `remove_tags`, `add_note`, `update_note`, `remove_note`,
  `find_notes` and `inspect_delete_impact` (these two are `kind: "read"` actions), and the cascading deletes `delete_actor_type`,
  `delete_scope`, `delete_item`, `delete_item_type`, `delete_transformation`, `delete_transformation_type` and `delete_conversion`; the
  catalogue and the parameters are generated topics, `scflow/actions` and `scflow/concepts`
  (`docs/reference/`, written by `scripts/build-docs.mjs` from `module.yaml` and committed), and the conventions
  (ID or name references, localized text) are in [`docs/action-conventions.md`](docs/action-conventions.md).

## Locations

A `location` is a geographic place where actors operate. An actor has an optional `location`,
and several actors can share one; the `location` schema declares no relation to actors, and
`actors` is generated on it. The engine gives an unset number the value 0 and an unset text the
empty value, so a `latitude` and a `longitude` that are both 0 mean that the location has no
coordinates, and an empty `country_code` or `un_locode` is unset. `latitude` and `longitude`
are bounded to -90..90 and -180..180, `country_code` is two uppercase letters and `un_locode`
five characters, such as `FRLEH`. The actions `create_actor` and `update_actor` take a `location`,
given by id or display name; the package ships no action that creates or changes a location.

## Actions

The rules of the network are declared on the schemas of `module.yaml` (`docs/spec/implementation.md`,
Network Rules): the engine refuses a breach at the end of any transaction with `rule_violation`, and a
body only writes what a rule cannot, such as the holdings of the ends of a flow.

An action takes the id or the display name of every entity it references, and a plain string
or a map of language to string for every text. It declares its parameters as JSON Schema, which
the registry checks before the body runs, and the schemas it writes in `writes`. An action that
takes the place of a CRUD operation is named by the `crud` of its schema and follows the CRUD
parameters. It opens no transaction: the host runs it in one, so a failure leaves the dataset
unchanged and a success is one undoable step.

```ts
const env = createEnvironment({ formats: [createJsPersistenceInterface()] });
await env.modules.load(folderOfThePackage);
const dataset = await env.datasets.create({ locator: "js:network", modules: ["scflow:core"] });

await dataset.run("scflow/create_actor_type", { display_name: "Warehouse" });
await dataset.run("scflow/create_actor", { display_name: "Main warehouse", type: "Warehouse" });
```
