# SCFlow Core packages

This folder holds the reusable SCFlow TypeScript packages: the supply chain flow modelling language. Each package lives in its own subfolder, for example `packages/<name>/`.

These packages are the source of truth. They are published and reused outside this project.

Rules:
- Packages must never import from `src/`, which holds the UI harness.
- Packages are copied in exactly as they are in the original repository.
- All packages are released under the MIT license (see the root `LICENSE` file); set `"license": "MIT"` in each package's own `package.json` when it is added.
