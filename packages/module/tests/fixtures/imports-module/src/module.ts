import { defineModule } from "../../../../src/index.js";
import manifest from "../module.yaml";
// a file of another module package: modules call each other by action id
import { hello } from "../../with-code/src/text.js";

export default defineModule(manifest, { migrations: { "1.0.0": () => hello("x") } });
