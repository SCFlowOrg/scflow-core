# SCFlow Core packages

This folder holds the reusable SCFlow TypeScript packages: the supply chain flow modelling language. Each package lives in its own subfolder, for example `packages/<name>/`.

These packages are the source of truth. They are developed, versioned and published from here, and they are reused outside this project.

| Package | Role | Depends on |
| --- | --- | --- |
| `core` | The MCL engine: schema processing, commands, scripts, filters, the TypeScript API; works only against `PersistenceInterface` | none |
| `actions` | The neutral action package: the action type aligned on MCP tools, parameters checked by Ajv, a registry, batches of calls, the export to AI tools and the run log | none (Ajv only) |
| `format-js` | The `js` persistent format, in memory | `core` |
| `format-file` | The `file` persistent format: a dataset stored in a project file, with a deterministic serialization | `core`, `format-js`, `project-file` |
| `conformance` | The suite a `PersistenceInterface` implementation runs against itself | `core` |
| `repl` | The interactive REPL, and the `scflow` command that works on a project through actions | `core`, `format-js`, `workspace` |
| `mcp` | The MCP server on the workspace | `actions`, `core`, `workspace` |
| `repl-conformance` | The same kind of suite, through the REPL command-block parser | `core`, `repl` |
| `core-plugin-core` | The runtime behind the `core-plugin` application plugin | `core`, `format-js` |
| `module` | The code of a module package: `defineModule`, the build of one bundle per module package, the bundle check, the check of the code against the manifest, `modules.load` | `core` (not its `defineModule` entry) |
| `environment` | The environment: the catalogue of modules with their code, formats given at creation, open datasets, the context of actions and the transaction of one action | `core`, `module` |
| `project-file` | The project file: the sectioned envelope in its two shapes, the registry of sections, the preservation of what a reader does not know | none |
| `workspace` | The workspace: documents, their sections, transactions and undo, with no UI | `core`, `environment`, `format-file`, `project-file` |
| `scflow-core` | The supply chain flow model: schemas and domain logic, the module `scflow:core` | `core`, `module` (at build), `environment` (in tests) |

Every package but `actions` and `project-file`, which are neutral, depends on `core`, so a change to `core` is built and tested on the whole repo.

Rules:
- Packages must never import from `src/`, which holds the UI harness.
- Packages must not be refactored as part of changes to the UI harness.
- All packages are released under the MIT license (see the root `LICENSE` file); set `"license": "MIT"` in each package's own `package.json`.
