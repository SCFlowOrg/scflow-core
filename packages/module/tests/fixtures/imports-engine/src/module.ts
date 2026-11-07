import { defineModule } from "../../../../src/index.js";
import { modelError } from "@scfloworg/core";
import manifest from "../module.yaml";

export default defineModule(manifest, { migrations: { "1.0.0": () => { throw modelError("constraint_violation"); } } });
