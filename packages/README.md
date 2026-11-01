# SCFlow Core packages

This folder holds the reusable SCFlow TypeScript packages: the supply chain flow modelling language. Each package lives in its own subfolder, for example `packages/<name>/`.

These packages are the source of truth. They are developed, versioned and published from here, and they are reused outside this project.

Rules:
- Packages must never import from `src/`, which holds the UI harness.
- Packages must not be refactored as part of changes to the UI harness.
- All packages are released under the MIT license (see the root `LICENSE` file); set `"license": "MIT"` in each package's own `package.json`.
