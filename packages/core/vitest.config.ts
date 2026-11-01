import { defineConfig } from "vitest/config";

// Deliberately empty. Without a local config file here, `vitest run` — as
// this package's own `test` script invokes it, with this directory as cwd —
// walks up and discovers the root `vitest.config.ts` instead. That config's
// `test.projects: ["packages/*"]` then resolves against this cwd rather than
// the repo root, producing "No projects were found" (vitest-dev/vitest#7759,
// closed as not planned upstream). An empty local config wins over the root
// one for this package's own runs, restoring standalone behavior — the same
// thing that happened by default before Vitest 4 introduced `projects`.
// Running `vitest run` from the repo root (not from in here) still uses the
// root config's `projects` to run every package's tests in one process.
export default defineConfig({});
