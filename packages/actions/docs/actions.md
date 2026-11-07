# Actions

The neutral action package holds the part of the action contract that does not
need the engine. The rules of actions are in the specification
([Action](../../core/docs/spec/meta-model.md#action),
[Script](../../core/docs/spec/model-command-language.md#script) and
[Action Package](../../core/docs/spec/typescript-reference-implementation.md#action-package));
this page gives the use of the package.

## Actions

```ts
interface ActionDefinition {
  id: string;                        // namespace/name, both identifiers
  title?: string;
  description?: string;
  kind?: "read" | "action";          // action by default
  destructive?: boolean;
  exposure?: "visible" | "hidden";   // visible by default
  parameters?: JsonSchema | string;  // a JSON Schema object, or its JSON text
  writes?: readonly string[];        // kept for the engine
}

interface Action<C = RunTrace> extends ActionDefinition {
  run(params: any, context: C): unknown;  // sync or async
}
```

A definition is the declaration of a manifest: a module lists it without code.
An `Action` adds its body, which receives the parameters after their check and
the context its host builds. Without a host context, the body receives its
`RunTrace`.

## Parameters

`parameters` is a JSON Schema object, draft 2020-12, the version of MCP tools,
checked by Ajv before the body runs, so a body checks nothing by hand.

- Its `type` is `object`. Absent, the action takes an empty object, and no
  parameters (`undefined`) stand for `{}`.
- An unknown keyword is refused when the action is registered, with
  `constraint_violation`, as a schema that is not valid. `format` is an
  annotation: no format vocabulary is loaded.
- `default` fills an absent property. The body receives a copy: the parameters
  of the caller do not change.
- Parameters that break the schema are refused with `invalid_parameters`; its
  message lists every breach.

**`ref`.** The keyword `ref` names a schema of the model: the value is the id of
an instance of it, or the exact `display_name` of one instance, in any
language, and the body receives the key. The package reads no instance, so the
host gives a resolver:

```ts
type RefResolver = (schema: string, value: string) => RefMatches | Promise<RefMatches>;
interface RefMatches {
  id: string | null;          // the key of the instance whose id is the value
  names: readonly string[];   // the keys of the instances whose display_name is the value
}
```

The package applies the rule: an id wins over a name that equals it, one name
gives its key, and no instance or several are refused with
`invalid_parameters`. A `ref` is found wherever it sits in the schema, in an
array or a nested object included. Without a resolver, a `ref` value reaches
the body as it is.

`validateParameters(definition, params, resolveRef?)` runs this check without a
registry.

## The registry

```ts
const registry = createActionRegistry<C>();
registry.register(action);
registry.get(id); registry.list();
const { result, entry } = await registry.run(id, params, host);
```

- `register` refuses an id that is not a namespace, a slash and a name with
  `constraint_violation`, and an id already registered with `duplicate_name`.
  It compiles the parameters once.
- `run` refuses an unknown id with `unknown_action`. It checks the parameters,
  runs the body and gives its result with the run entry of the call. A refused
  call throws its exception as it is.
- **It opens no transaction.** The host runs the call inside the transaction of
  the action, and rolls it back when the call throws.

The host of a run:

```ts
interface RunHost<C> {
  context?(trace: RunTrace): C;      // the context of each body, built on its trace
  resolveRef?: RefResolver;
  onEntry?(entry: RunEntry): void;   // each top-level entry, done or refused
}

interface RunTrace {
  action: string;
  command(command, result): void;    // records a command the body emitted
  call(id, params?): Promise<unknown>; // runs another action, recorded as a step
}
```

The engine builds the context of a body on the trace: each command it runs for
the body is recorded with `trace.command`, and its `call` goes through
`trace.call`, so the run log holds what the body did. Which actions a body may
call, and which schemas it may write, are checked by the engine.

## The run log

A run entry follows `run_entry` of the specification:

```ts
interface RunEntry {
  action: string;
  parameters: string;          // canonical JSON, after the check, refs resolved
  steps: RunStep[];            // { command, result } or { call: RunEntry }
  outcome: "done" | "refused";
  error?: string;              // the code of the exception of a refused call
  result?: string;             // canonical JSON; absent when the body returned none
}
```

- Every call has an entry, a refused one included. A call refused by its
  parameters records the parameters it was given.
- A nested call is a step of the entry that makes it, refused or not.
- A command is recorded as the body emitted it, so `${now()}` and the keys of
  the engine stay placeholders, and its result in canonical JSON.
- `canonicalJson(value)` writes the canonical form: the keys of every object
  sorted and no white space. A replay compares steps in this form.
- `createRunLog()` keeps entries in memory: pass `log.record` as `onEntry`.

## Batches

```ts
const { result, entries } = await runBatch(registry, {
  commands: [
    { call: "scflow/create_actor", with: { display_name: "Plant", type: "plant" }, as: "plant" },
    { call: "carbon/update_actor_emissions", with: { id: "${plant.id}", co2: 12 } },
  ],
  result: "${plant}",
}, host);
```

The package runs a batch whose steps are calls, each with `with` and `as` only.

- The batch is checked whole first: any other step, such as a command, `when`,
  `each` or `fail`, and a batch with `parameters`, are refused with
  `invalid_script_step`, before any call. The engine runs such a batch through
  its script runner.
- Before each call, the placeholders of `with` are resolved against the results
  named so far, by the rules of placeholders on arrays: an index, `*` for every
  entry, or entry `0` by default. A placeholder that is the whole string gives
  the value of any type, one inside text gives its text, and a value that
  resolves to nothing leaves its property out.
- A placeholder whose first segment is not an `as` name set yet is refused with
  `unknown_reference`. A placeholder that is not a path, such as `${now()}`, is
  passed on to the called action.
- The result of the batch is its `result` placeholder, or the result of its last
  call. `entries` holds the entry of each call, which `host.onEntry` also
  receives.
- A refused call stops the batch and its exception is thrown. **The host runs
  the batch in one transaction**, rolled back when it throws, so a batch is
  undone as one.

## Export to AI tools

`toAiTools(actions)` maps each `visible` action to an MCP tool definition:

| Tool | From the action |
| --- | --- |
| `name` | `toolName(id)`: the slash replaced by a hyphen, `scflow/create_actor` gives `scflow-create_actor` |
| `title`, `description` | As they are |
| `inputSchema` | `parameters`, `ref` included, or an empty object schema |
| `annotations.readOnlyHint` | `kind: read` |
| `annotations.destructiveHint` | `destructive` |

A hyphen never appears in an identifier, so `actionIdOfTool(name)` gives the id
back for a call that comes from an AI client. An action whose `exposure` is
`hidden` is left out; `toAiTool(action)` maps one action whatever its exposure.

## Hand-off to the engine

These parts are given to the package by the engine, in later pieces:

- the resolver of `ref` (`RunHost.resolveRef`) and the context of bodies built
  on the trace (`RunHost.context`), with the action declarations per module
  and the generated actions;
- the steps `when`, `each` and `fail` of a batch, and procedures, run by the
  script runner of the engine;
- the replay of a body against its run entries, which compares steps in
  canonical JSON.

## Errors

The package throws `ActionError`, whose `code` is one of `invalid_parameters`,
`unknown_action`, `duplicate_name`, `constraint_violation`,
`invalid_script_step` and `unknown_reference`, the codes the engine uses for the
same causes. An exception of a body is thrown as it is.
