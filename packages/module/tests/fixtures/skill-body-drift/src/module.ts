/// <reference types="../../../../yaml.d.ts" />
import { defineModule } from "../../../../src/index.js";
import manifest from "../module.yaml";

export default defineModule(manifest, { skills: { write_tips: "# Write tips\n\nAnother text.\n" } });
