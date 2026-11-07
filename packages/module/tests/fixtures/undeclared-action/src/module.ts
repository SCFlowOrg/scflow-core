import { defineModule } from "../../../../src/index.js";
import manifest from "../module.yaml";

export default defineModule(manifest, { actions: { not_declared: () => undefined } });
