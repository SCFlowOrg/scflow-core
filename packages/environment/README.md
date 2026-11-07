# @scfloworg/environment

The environment of SCFlow: the catalogue of modules with their code, the formats
given at creation, the open datasets, the context of actions and the transaction
of one action. It is an API of the implementation, built on the engine
`@scfloworg/core` and on `@scfloworg/module`, with no UI and no file of its own.
A workspace, a server or a test creates one. The rules are in
[docs/environment.md](docs/environment.md).

```ts
import { createEnvironment } from "@scfloworg/environment";
import { createJsPersistenceInterface } from "@scfloworg/format-js";
import carbonModule from "./carbon/src/module.js"; // its default export: a defineModule result

const env = createEnvironment({ formats: [createJsPersistenceInterface()] });
await env.modules.load("packages/scflow-core");     // the CLI or MCP, from a folder
env.modules.install(carbonModule);                 // a plugin, from a static import

const dataset = await env.datasets.create({ modules: ["acme:carbon"] });
const { result, delta } = await dataset.run("carbon/update_actor_emissions", { id, co2: 12 });

const dump = await dataset.dump("yaml");            // both modules embedded
const copy = await createEnvironment({ formats: [createJsPersistenceInterface()] })
  .datasets.restore("js:copy", dump, "yaml");       // read only unless its modules are installed
```

| Part | Holds |
| --- | --- |
| `createEnvironment({ formats })` | An engine of its own, made by `createEngine` of `@scfloworg/core`: two environments share nothing |
| `env.modules` | One active version of each module, with its code: `install`, `load`, `get`, `list` |
| `env.datasets` | `create`, `open`, `restore`, `get`, `list`; an open dataset knows the state of each of its modules |
| `dataset.run(id, params)` | One action, in one transaction the environment opens; its body receives an `ActionContext` |
| `dataset.query`, `info`, `dump`, `close` | Reads and saving, outside any action |

An action body is a function `(context, params) => result`. Its
`ActionContext` is an `MclAccess` limited to the dataset of the action, with
`call(id, params)` for the actions of its module and of its dependencies: it is
the only way a body reaches the engine. The body imports only types from
`@scfloworg/core` and this package.

Not here yet: the validation of parameters, procedures and the run log (the
action package), model upgrades, the refusal of writes outside an action
(piece 1.8 of the engine), and documents, files and undo (the workspace).
