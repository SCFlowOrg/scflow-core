# @scfloworg/actions

The neutral action package: the action type aligned on MCP tools, the check of
parameters by a standard JSON Schema validator, a registry, batches of calls,
the export of actions as AI tools, and the run log of executed actions.

It depends on no other SCFlow package and knows no model, so a host that is not
MCL, such as an application framework, uses it as it is. Its only dependency is
[Ajv](https://ajv.js.org). The engine plugs in what needs a dataset: the
resolution of `ref` values, the context of bodies, the steps `when`, `each` and
`fail` of a batch, and the transaction. The rules are in the specification
([Action](../core/docs/spec/meta-model.md#action) and
[Action Package](../core/docs/spec/typescript-reference-implementation.md#action-package)),
and the use of the package in [docs/actions.md](docs/actions.md).

```ts
import { createActionRegistry, createRunLog, runBatch, toAiTools } from "@scfloworg/actions";

const registry = createActionRegistry();
registry.register({
  id: "demo/create_actor",
  title: "Create an actor",
  description: "Creates an actor and returns it",
  parameters: {
    type: "object",
    properties: { display_name: { type: "string" }, parent: { type: "string", ref: "actor" } },
    required: ["display_name"],
  },
  run(params, trace) {
    const actor = { id: "a1", ...params };
    trace.command({ create: "actor", input: params }, { after: [actor] });
    return actor;
  },
});

const log = createRunLog();
const { result } = await registry.run("demo/create_actor", { display_name: "Plant" }, { onEntry: log.record });

await runBatch(registry, {
  commands: [
    { call: "demo/create_actor", with: { display_name: "Plant" }, as: "plant" },
    { call: "demo/create_actor", with: { display_name: "Line", parent: "${plant.id}" } },
  ],
}, { onEntry: log.record });

const tools = toAiTools(registry.list()); // MCP tool definitions, hidden actions left out
```

| Part | Gives |
| --- | --- |
| `Action`, `ActionDefinition` | The declaration of an action, as a manifest holds it, and its body `run(params, context)` |
| `validateParameters` | The check of parameters against their JSON Schema, with defaults and `ref` resolution |
| `createActionRegistry` | `register`, `get`, `list` and `run`: one call, checked and recorded |
| `runBatch` | A batch of `call` steps with `${name.path}` references |
| `toAiTools`, `toolName`, `actionIdOfTool` | The export to AI tools, in the schema AI providers accept |
| `RunEntry`, `createRunLog`, `canonicalJson` | The run log of the specification, in canonical JSON |
| `ActionError` | The error of the package; callers branch on `.code` |

The cases of the language it follows are in `@scfloworg/conformance`, as
`runActionConformanceSuite`, which `tests/conformance.test.ts` runs against this
package.
