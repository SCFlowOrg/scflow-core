import { TESTING_ENGINE, createTestingEngine, registerPersistentFormat } from "./api.js";

/**
 * The entry for tests: the free functions of the API, which may write outside
 * an action, so that a test can set up its data and check a command by itself.
 * A host never uses it: see Writes and actions in
 * `docs/spec/typescript-reference-implementation.md`.
 */
export { createTestingEngine, registerPersistentFormat };

export const {
  initDataset,
  queryDataset,
  bumpMajorVersions,
  deleteDataset,
  dumpDataset,
  restoreDataset,
  setLocalModule,
  checkImport,
  createImport,
  removeImport,
  refreshImport,
  createUpgradeLocator,
  queryUpgradeLocator,
  checkUpgrade,
  upgradeDataset,
  runCommand,
  runScript,
  createScriptSession,
  createApiSession,
  subscribeObservable,
} = TESTING_ENGINE;
