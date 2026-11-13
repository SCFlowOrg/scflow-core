/// <reference types="@scfloworg/module/yaml" />
/// <reference types="@scfloworg/module/markdown" />
// The entry of the bundle of the module scflow:core, built to dist/module.js
// by scripts/build-module.mjs (see docs/spec/implementation.md, Schemas
// Package). It is not compiled by tsc -b: tsconfig.module.json type-checks it.
import { defineModule, type ModuleBody } from "@scfloworg/module";
import manifest from "../module.yaml";
import imageToModel from "../skills/image-to-model.md";
import physicalToInformationFlows from "../skills/physical-to-information-flows.md";
import { ACTION_BODIES } from "./actions/index.js";

// A body takes the context of the action and its parameters, as an environment
// calls it (`ActionContext` of `@scfloworg/environment`), and runs the action.
// The body of a skill is the text of its file, by the name of the skill.
export default defineModule(manifest, {
  actions: ACTION_BODIES as Record<string, ModuleBody>,
  skills: { image_to_model: imageToModel, physical_to_information_flows: physicalToInformationFlows },
});
