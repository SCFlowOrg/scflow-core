/// <reference types="../../../../yaml.d.ts" />
/// <reference types="../../../../markdown.d.ts" />
import { defineModule } from "../../../../src/index.js";
import manifest from "../module.yaml";
import writeTips from "../skills/write-tips.md";

export default defineModule(manifest, {
  actions: { publish_tip: () => undefined },
  skills: { write_tips: writeTips },
});
