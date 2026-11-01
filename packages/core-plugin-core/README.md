# @scfloworg/core-plugin-core

Pure runtime behind the `core-plugin` app plugin: one MCL dataset per
document, a shared built-in (`js:app`) holding every plugin's schemas,
undo/redo through core transactions, and a filtered `MclAccess`.
No kernel, no React.

## Exports

- `.` — `createCoreRuntime({ area })`, `CoreAccessError`, and the public
  types (`CorePluginApi`, `CoreDocumentType`, `SchemaPackage`).
- `./testing` — `createTestDocument(schemas)` for business package tests.
- `./types` — the types only.

## Build and test

```
bun run build   # tsc -p tsconfig.build.json -> dist/
bun run test    # bun test tests/
```

Depends on `@scfloworg/core` and `@scfloworg/format-js` (browser entry).

## Docs

- [Business model packages](docs/business-model.md) — how to write a
  `<name>-core` package on top of this runtime.
