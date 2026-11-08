import { runActionConformanceSuite } from "@scfloworg/conformance";
import { canonicalJson, createActionRegistry, runBatch, toAiTools } from "../src/index.js";

// The cases of the action contract that need no dataset, run against this package.
runActionConformanceSuite({
  createRegistry: () => createActionRegistry(),
  runBatch: (registry, batch, host) =>
    runBatch(registry as ReturnType<typeof createActionRegistry>, batch as never, host),
  toAiTools: (actions) => toAiTools(actions),
  canonicalJson,
});
