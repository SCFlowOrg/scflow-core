import { defineModule } from "../../../../src/index.js";
import manifest from "../module.yaml";

export default defineModule(manifest, { actions: {}, migrations: { stamp: () => Date.now() } });
