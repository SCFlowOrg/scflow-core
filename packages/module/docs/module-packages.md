# Module packages

A module package is the package of one module: its manifest, `module.yaml`, its
code when it has any, and the files of its skills. The rules of a module are in
the specification: [Module](../../core/docs/spec/meta-model.md#module),
[Action](../../core/docs/spec/meta-model.md#action), with the contract of a
body, and [Skill](../../core/docs/spec/meta-model.md#skill). This page gives the
implementation: how the code is declared, built to one bundle, checked and
loaded.

```text
packages/scflow-core/
  module.yaml
  skills/
    image-to-model.md # the body of a skill
  src/
    module.ts         # default export: defineModule(manifest, code)
    actions/
  dist/
    module.js         # the bundle
```

A module package publishes its manifest and the files of its skills with its
bundle: `files` of its `package.json` lists `module.yaml` and `skills`.

## Declare the code

The entry of the bundle, `src/module.ts`, has one default export: the result of
`defineModule(manifest, { actions, migrations, skills })`.

```ts
/// <reference types="@scfloworg/module/yaml" />
/// <reference types="@scfloworg/module/markdown" />
import { defineModule } from "@scfloworg/module";
import manifest from "../module.yaml";
import imageToModel from "../skills/image-to-model.md";
import { defineProcess } from "./actions/define-process.js";
import { splitActor } from "./migrations/split-actor.js";

export default defineModule(manifest, {
  actions: { define_process: defineProcess },
  migrations: { "2.0.0": splitActor },
  skills: { image_to_model: imageToModel },
});
```

- `actions` maps the name of an action, the part of its id after the slash, to
  its body. `define_process` is the body of `scflow/define_process`.
- `migrations` maps a version to the body of the migration that reaches it. It
  keeps every migration, because a dataset can be several versions behind.
- `skills` maps the name of a skill, the part of its id after the slash, to its
  body: the Markdown text of the `file` the manifest names, imported from it.
  The body travels in the bundle, like the manifest, so a host with no file
  system has it too.
- A body is a function `(context, params) => result`, sync or async. The
  context is the context of actions, which the environment gives (see
  [`@scfloworg/environment`](../../environment/docs/environment.md), The
  context of an action); `defineModule` does not call it.
- `defineModule` checks nothing and imports nothing: it returns the manifest and
  the code, frozen. The host checks them when it loads the module.

`@scfloworg/module`, the entry that holds `defineModule`, has no runtime
dependency, so a bundle that inlines it holds nothing else. The code of a
module imports only types from `@scfloworg/core`: a body reaches the engine only
through what it receives, and the host gives the one instance of the engine.

## Build the bundle

`buildModule(folder)`, from `@scfloworg/module/build`, builds `src/module.ts` of
the folder to `dist/module.js`.

```ts
import { buildModule } from "@scfloworg/module/build";

const result = await buildModule("packages/scflow-core");
result.bundle; // the path of dist/module.js, or null for a module with no code
```

- **One ES module.** The bundle is one file with no chunk: the manifest is
  inlined as data, `defineModule` and the other libraries of the package are
  bundled in, and its only export is the default one. It is the only thing a
  host needs.
- **No engine, no other module.** An import of `@scfloworg/core` that is not
  erased as a type, an import of a Node built-in, and an import of a file of
  another module package, a folder with its own `module.yaml`, stay imports, so
  the check refuses them. Modules call each other by action id.
- **A module with no code has no bundle.** When `src/module.ts` does not exist,
  `buildModule` writes nothing, removes a `dist/module.js` left by an earlier
  build, and returns `bundle: null`.
- **Checked before it is written.** The bundle goes through the bundle check
  below, then the build imports it and checks its code against the manifest, as
  `modules.load` does. A failure throws and leaves no bundle.
- **Skills.** The build first checks that the file of each skill exists in the
  package, with or without code. The body of a skill in the bundle must be the
  text of its file, so the two cannot drift apart.

`yaml.d.ts`, exported as `@scfloworg/module/yaml`, declares the import of a
`.yaml` file for the type checker. The build reads it with a YAML parser.
`markdown.d.ts`, exported as `@scfloworg/module/markdown`, declares the import
of a `.md` file, which the build inlines as its text.

## Check the bundle

`checkBundle(code)`, from `@scfloworg/module/build`, parses the code of a bundle
and returns the list of its breaches, empty for a bundle that passes. It is the
first of the three levels of the contract of a body: it is fast, and a static
analysis proves nothing alone. The sandbox, at run, and the replay, in
conformance, are the other two.

| Rule | A breach |
| --- | --- |
| `import` | An `import` declaration, or an `export ... from` |
| `dynamic_import` | `import(...)` |
| `import_meta` | `import.meta` |
| `export` | An export other than the default one |
| `no_default_export` | No default export |
| `forbidden_global` | `eval` or `Function` |
| `global` | A free name that is not an allowed global |
| `random` | `Math.random` |

The allowed globals are the parts of ECMAScript that read nothing of the host:

- values: `undefined`, `NaN`, `Infinity`;
- functions: `isFinite`, `isNaN`, `parseFloat`, `parseInt`, `encodeURI`,
  `encodeURIComponent`, `decodeURI`, `decodeURIComponent`;
- objects: `Object`, `Array`, `String`, `Number`, `Boolean`, `Symbol`, `BigInt`,
  `Math` (without `random`), `JSON`, `RegExp`, `Map`, `Set`, `WeakMap`,
  `WeakSet`, `Promise`, `Reflect`, `Proxy`, `Iterator`;
- errors: `Error`, `TypeError`, `RangeError`, `SyntaxError`, `ReferenceError`,
  `EvalError`, `URIError`, `AggregateError`;
- binary data: `ArrayBuffer`, `DataView`, and the typed arrays.

Every other global is refused, among them `Date`, a clock, `globalThis`,
`console`, `Intl`, whose results depend on the host, timers, `fetch`,
`crypto`, `process`, `WeakRef` and `FinalizationRegistry`. Time and ids come
from MCL.

## Load a module

`modules.load(path)`, from `@scfloworg/module/host`, loads the module of a
folder, for a host that reads modules from disk, such as the CLI or the MCP
server.

```ts
import { modules } from "@scfloworg/module/host";

const scflow = await modules.load("packages/scflow-core");
scflow.manifest.name;                    // "scflow:core"
scflow.actions.get("scflow/create_actor"); // its body
```

1. It reads `module.yaml` and validates it as an instance of the `module`
   schema, with `readModuleManifest` of `@scfloworg/core`.
2. When `dist/module.js` exists, it checks the bundle with `checkBundle`, then
   imports it. A module with no bundle loads with no code.
3. It checks the code against the manifest.
4. It gives each skill a loader of its body: from the bundle, or, for a module
   with no code, from its file, which must exist and is read when the body is
   asked for.

It returns a `ModulePackage`: the `path` of the folder, the `manifest`, the path
of the `bundle` or `null`, the bodies by id in `actions` and by version in
`migrations`, and the loader of each skill body by skill id in `skills`.

A module is refused with `constraint_violation` of `@scfloworg/core` when:

- the bundle breaks the bundle check, which the message lists;
- its default export is not the result of `defineModule`;
- the manifest it inlines is not the module of the folder, by `name` and
  `version`: a bundle left by an earlier version;
- an action of the code is not declared by the manifest: a bundle has no
  declaration;
- an action declared with no `body` has no code: a declared action has no
  procedure and no bundle;
- a migration of the code reaches a version that no migration of the manifest
  declares with `to`;
- the code has no body for a declared skill, or a body for a skill the manifest
  does not declare;
- a module with no code names a skill file the folder does not hold.

`checkModuleCode(manifest, bundle)`, from `@scfloworg/module/code`, is this
check alone, given the manifest and the default export of a bundle, or `null`
for a module with no code. It reads no file, so an environment that installs a
module given by `defineModule` runs it as `modules.load` does.

A body is a function, and nothing else of it is checked: running it is the
environment's.
