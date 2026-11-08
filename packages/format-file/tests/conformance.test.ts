import { runConformanceSuite } from "@scfloworg/conformance";
import { createFileFormat } from "../src/index.js";

runConformanceSuite(createFileFormat(), "file");
