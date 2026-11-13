# SCFlow Core

The SCFlow core packages: the Model Command Language (MCL) engine, the formats, the action and AI packages, the workspace, the MCP server and the supply chain flow model `scflow:core`.

The packages live in [`packages/`](packages/README.md), each with its own `README.md`, specification and tests. They are released under the MIT license.

The web application that browses models and runs actions on them is a separate repository, [scflow-explorer](https://github.com/SCFlowOrg/scflow-explorer).

## Build and test

The packages are built with [Bun](https://bun.sh) workspaces and TypeScript.

```bash
bun install
bun run build:packages
bun run test:packages
```

## A first example

```ts
import { createEngine } from "@scfloworg/core";
import { jsFormat } from "@scfloworg/format-js";

const engine = createEngine({ formats: [jsFormat] });
await engine.initDataset("js:app/demo", "Demo");
```

See `packages/core/README.md` for the language and the TypeScript API, and `packages/core/docs/spec/` for its specification.

## Contributing

Issues and pull requests follow the organization [contribution guide](https://github.com/SCFlowOrg/.github/blob/main/CONTRIBUTING.md).
