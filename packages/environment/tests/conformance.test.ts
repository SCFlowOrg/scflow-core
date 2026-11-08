import { runModuleActionConformanceSuite } from "@scfloworg/conformance";
import type { ConformanceEnvironment, ModuleActionImplementation } from "@scfloworg/conformance";
import { createJsPersistenceInterface } from "@scfloworg/format-js";
import { defineModule } from "@scfloworg/module";
import { createEnvironment } from "../src/index.js";

runModuleActionConformanceSuite({
  createEnvironment: () =>
    createEnvironment({
      formats: [createJsPersistenceInterface()],
    }) as unknown as ConformanceEnvironment,
  defineModule: defineModule as unknown as ModuleActionImplementation["defineModule"],
});
