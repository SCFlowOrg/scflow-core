/// <reference types="../../../../yaml.d.ts" />
/// <reference types="../../../../markdown.d.ts" />
import { defineModule } from "../../../../src/index.js";
import manifest from "../module.yaml";
import tips from "../docs/tips.md";
import tipsFr from "../docs/tips.fr.md";

export default defineModule(manifest, {
  actions: { publish_tip: () => undefined },
  docs: { "docs/tips.md": tips, "docs/tips.fr.md": tipsFr },
});
