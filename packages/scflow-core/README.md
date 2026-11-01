# @scfloworg/scflow-core

Business package of the supply chain flow model: MCL schemas and pure domain logic.
The model is stated in the `scflow_model` document of the `core` dataset.

## Exports

- `SCHEMAS`: the scalar types and schemas, compiled from `src/schemas.yaml`.
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
  it does not check the domains of the actors. A flow between an actor and one of its child actors
  must carry an `item`. A given `item` must have a domain among the domains of both actors, and
  the call creates the `item_at_actor` that the source and the destination lack. It throws when an
  actor or the item does not exist, or when one of these rules fails.
- `setFlowItem(mcl, locator, { flow, item })`: sets the item of a flow that carries none, with the same
  checks and holdings as `createFlow`. The item of a flow never changes and is never removed: it throws when
  the flow carries another item, and changes nothing when it already carries `item`.
- `ACTIONS`: the model actions of the package, as `ModelActionDefinition` values for UIs, AI
  assistants and macros. The host registers them, for example with
  `registerModelActions(ACTIONS)` in `@scfloworg/core-plugin-core`. The package exports
  `create_actor`, `update_actor`, `delete_actor`, `create_actor_type`, `create_scope`,
  `create_flow`, `update_flow`, `set_flow_item`, `delete_flow`, `create_item_type`, `create_item`, `update_item`, `hold_item`,
  `release_held_item`, `create_transformation_type`,
  `create_transformation`, `connect_transformation_line`, `define_process`, `create_conversion`, `update_conversion`, `add_tags`, `remove_tags`, `add_note`, `update_note`, `remove_note`,
  `find_notes` and `inspect_delete_impact` (these two are `kind: "read"` actions), and the cascading deletes `delete_actor_type`,
  `delete_scope`, `delete_item`, `delete_item_type`, `delete_transformation`, `delete_transformation_type` and `delete_conversion`; the
  catalog, the parameters and the conventions (ID or name references, localized text) are in
  [`docs/actions.md`](docs/actions.md).

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

An action takes the id or the display name of every entity it references, and a plain string
or a map of language to string for every text. It checks its parameters and throws an error
that names the faulty parameter, before it writes anything. It opens no transaction: the host
runs it in one, so a failure leaves the dataset unchanged and a success is one undoable step.

```ts
import { ACTIONS } from "@scfloworg/scflow-core";

runtime.registerModelActions(ACTIONS);
await runtime.runModelAction(docId, "scflow/create_actor", { name: "Main warehouse", type: "Warehouse" });
```
