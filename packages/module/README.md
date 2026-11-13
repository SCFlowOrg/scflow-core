# @scfloworg/module

The code of a module package: `defineModule`, the build of one bundle per module
package, the bundle check, and `modules.load`. The rules are in
[docs/module-packages.md](docs/module-packages.md).

| Entry | Holds | Runs in |
| --- | --- | --- |
| `@scfloworg/module` | `defineModule(manifest, { actions, migrations, skills })` and its types. No runtime dependency: a bundle inlines it | A bundle |
| `@scfloworg/module/build` | `buildModule(folder)`, which builds `src/module.ts` to `dist/module.js`, and `checkBundle(code)` | Node, at build |
| `@scfloworg/module/code` | `checkModuleCode(manifest, bundle)`, which checks the code of a module against its manifest. It reads no file | A host, Node or browser |
| `@scfloworg/module/host` | `modules.load(path)`, which reads `module.yaml`, validates it, checks and imports the bundle when there is one, and gives a loader for each skill body | Node, in a host |
| `@scfloworg/module/yaml` | The type of a `.yaml` import, for the type checker | Types only |
| `@scfloworg/module/markdown` | The type of a `.md` import, the body of a skill, for the type checker | Types only |

```ts
// src/module.ts of a module package
/// <reference types="@scfloworg/module/yaml" />
import { defineModule } from "@scfloworg/module";
import manifest from "../module.yaml";
import { createActor } from "./actions/create-actor.js";

export default defineModule(manifest, { actions: { create_actor: createActor } });
```

```ts
// scripts of the package, at build
import { buildModule } from "@scfloworg/module/build";
await buildModule(packageFolder); // dist/module.js and dist/module.d.ts, or nothing for a module with no code

// a host that reads modules from disk
import { modules } from "@scfloworg/module/host";
const module = await modules.load(packageFolder);

// a host that bundles its modules (a browser): the package exports "./module"
import carbon from "@scfloworg/module-carbon/module";
environment.modules.install(carbon);
```

The bundle holds no copy of the engine: the code of a module imports only types
from `@scfloworg/core`, and the host gives the one instance. The environment, with
its catalogue, `modules.install` and the context of actions, is
[`@scfloworg/environment`](../environment/README.md).
