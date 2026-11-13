# Purpose of this repo

This repo holds the SCFlow core packages in `packages/*`. They are the product:
designed, changed and released from here, and reused by other projects. The web
application that visualizes datasets is a separate repository,
[scflow-explorer](https://github.com/SCFlowOrg/scflow-explorer); it consumes the
packages and never shapes them.

- A change to MCL, the engine, a format or a domain package is made here, in
  `packages/*`, with its tests and its docs (`packages/*/docs`, `README.md`).
- When the language changes (a command, a constraint, a type rule), update its
  specification in `packages/core/docs/spec/` first, then the code. A change to the
  flow model updates `packages/module-scflow-core/docs/spec/` first, the same way.
- Write the failing test first. A rule of the language gets a case in
  `@scfloworg/conformance`; a rule of the command-block syntax gets a fixture in
  `@scfloworg/repl-conformance`.
- Update doc comments, the package `README.md` and the `docs/` file of the topic
  in the same change, then build and test the whole repo: every package depends
  on `core`.
- A package change is decided on its own merits, not to suit one consumer: never
  bend a package API, add a package dependency, or refactor a package just
  because an application needs it.

# Work on one layer at a time

This rule comes before the others. An AI assistant works on one layer and one
concern at a time, from the original intent of the work.

- Before reading anything, state the intent, the one layer and concern, and what
  is out of scope. When one of them is unclear, ask.
- Decompose first, and settle a lower layer before the layers that use it.
- Think from the layer itself. A mechanism of MCL is designed from its own
  concerns: a domain package uses it, is an example at most, and never specifies it.
- Read only what the layer needs. A file being available is no reason to read it.
- Note what falls outside in one line, without analysing it or proposing changes.
- Answer the question asked, on the layer of the work, with no unrequested options
  or redesign.

# Project rules

- The packages are built with Bun workspaces; their shared compiler options live in the root `tsconfig.base.json`.
- Build with `bun run build:packages` and test with `bun run test:packages`.
- This is an open-source project. Never commit secrets, credentials, or private data.
- Issues and pull requests follow the organization [contribution guide](https://github.com/SCFlowOrg/.github/blob/main/CONTRIBUTING.md).
