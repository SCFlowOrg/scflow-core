import { runConformanceSuite } from "@scfloworg/conformance";
import { createSectionsFormat } from "../src/browser.js";
import { createFileFormat } from "../src/index.js";

runConformanceSuite(createFileFormat(), "file");
runConformanceSuite(createSectionsFormat({ name: "sections" }), "sections");
