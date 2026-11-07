# SCFlow Core packages

This folder holds the reusable SCFlow TypeScript packages: the supply chain flow modelling language. Each package lives in its own subfolder, for example `packages/<name>/`.

These packages are the source of truth. They are developed, versioned and published from here, and they are reused outside this project.

| Package | Role | Depends on |
| --- | --- | --- |
| `core` | The MCL engine: schema processing, commands, scripts, filters, the TypeScript API; works only against `PersistenceInterface` | none |
| `format-js` | The `js` persistent format, in memory | `core` |
| `conformance` | The suite a `PersistenceInterface` implementation runs against itself | `core` |
| `repl` | The interactive REPL | `core`, `format-js` |
| `repl-conformance` | The same kind of suite, through the REPL command-block parser | `core`, `repl` |
| `core-plugin-core` | The runtime behind the `core-plugin` application plugin | `core`, `format-js` |
| `module` | The code of a module package: `defineModule`, the build of one bundle per module package, the bundle check, `modules.load` | `core` (not its `defineModule` entry) |
| `scflow-core` | The supply chain flow model: schemas and domain logic, the module `scflow:core` | `core`, `module` (at build) |

Every package depends on `core`, so a change to `core` is built and tested on the whole repo.

Rules:
- Packages must never import from `src/`, which holds the UI harness.
- Packages must not be refactored as part of changes to the UI harness.
- All packages are released under the MIT license (see the root `LICENSE` file); set `"license": "MIT"` in each package's own `package.json`.
