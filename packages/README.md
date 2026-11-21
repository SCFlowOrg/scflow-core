# SCFlow Core packages

This folder holds the reusable SCFlow TypeScript packages: the supply chain flow modelling language. Each package lives in its own subfolder, for example `packages/<name>/`.

These packages are the source of truth. They are developed, versioned and published from here, and they are reused outside this project.

| Package | Role | Depends on |
| --- | --- | --- |
| `core` | The MCL engine: schema processing, commands, scripts, filters, the TypeScript API; works only against `PersistenceInterface` | none |
| `actions` | The neutral action package: the action type aligned on MCP tools, parameters checked by Ajv, a registry, batches of calls, the export to AI tools and the run log | none (Ajv only) |
| `docs` | The neutral documentation package: Markdown topics with front matter, the source contract, the catalogue (locale fallback, audience filter, id and help-key resolution, search), the manifest and the read tool contract | none |
| `ai` | The neutral AI package: the types of a conversation with a language model, connections, an OpenAI-compatible transport over `fetch`, model profiles, normalized errors, usage reports and the agent loop | none |
| `format-js` | The `js` persistent format, in memory | `core` |
| `format-file` | The `file` persistent format: a dataset stored in a project file, with a deterministic serialization | `core`, `format-js`, `project-file` |
| `conformance` | The suite a `PersistenceInterface` implementation runs against itself | `core` |
| `repl` | The interactive REPL, and the `scflow` command that works on a project through actions, by hand or by a language model (`ask`) | `actions`, `ai`, `core`, `format-js`, `workspace` |
| `mcp` | The MCP server on the workspace | `actions`, `core`, `workspace` |
| `repl-conformance` | The same kind of suite, through the REPL command-block parser | `core`, `repl` |
| `module` | The code of a module package: `defineModule`, the build of one bundle per module package, the bundle check, the check of the code against the manifest, `modules.load` | `core` (not its `defineModule` entry) |
| `environment` | The environment: the catalogue of modules with their code, formats given at creation, open datasets, the context of actions and the transaction of one action | `core`, `module` |
| `project-file` | The project file: the sectioned envelope in its two shapes, the registry of sections, the preservation of what a reader does not know | none |
| `workspace` | The workspace: documents, their sections, transactions and undo, with no UI | `core`, `environment`, `format-file`, `project-file` |
| `spreadsheet` | The neutral conversion of a dataset to rows of sheets and back: the export, the import through the actions of the model in one transaction, the dry run. No file format, no UI | `core` |
| `module-scflow-core` | The supply chain flow model: schemas and domain logic, the module `scflow:core` | `core`, `module` (at build), `environment` (in tests) |

Every package but `actions`, `ai`, `docs` and `project-file`, which are neutral, depends on `core`; `spreadsheet` depends on `core` only, so a change to `core` is built and tested on the whole repo.

Rules:
- Packages must never import from `src/`, which holds the UI harness.
- Packages must not be refactored as part of changes to the UI harness.
- All packages are released under the MIT license (see the root `LICENSE` file); set `"license": "MIT"` in each package's own `package.json`.

## Releasing and installing a pre-release

A release is one tag `v*` on a commit of `main`; the workflow `.github/workflows/release.yml` builds and tests the repository, then publishes, in dependency order, every public package whose version is not on npmjs.org yet. The tag is therefore one for the whole repository (for example `v0.2.0-next.1`), and it publishes only the packages whose version changed.

A version with a `-` suffix (`0.2.0-next.1`) is a pre-release: the workflow publishes it under the dist-tag `next`, so `latest` stays on the last stable version. Packages that depend on a pre-release of a sibling must list it in their range (`^0.2.0-next.1`), since a range such as `^0.2.0` does not match a pre-release; when a package changes, bump the packages that depend on it in the same release, so that one installation never holds two copies of `core`.

The `version` of the manifest `module.yaml` of a module package is `major.minor.patch` with no suffix: the package `@scfloworg/module-scflow-core@2.0.0-next.1` is a pre-release of the module version `2.0.0`.

To install a pre-release, give its exact version, since a range does not select the `next` tag by itself:

```bash
bun add @scfloworg/core@0.2.0-next.1
```

Bun refuses a package version younger than 24 hours (`minimumReleaseAge` in `bunfig.toml`). For a package published less than a day ago, add its name to `minimumReleaseAgeExcludes` in the `bunfig.toml` of the project that installs it, and remove it once the version is a day old.
