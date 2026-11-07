/// <reference types="@scfloworg/module/yaml" />
// The entry of the bundle of the module scflow:core, built to dist/module.js
// by scripts/build-module.mjs (see docs/spec/implementation.md, Schemas
// Package). It is not compiled by tsc -b: tsconfig.module.json type-checks it.
import { defineModule, type ModuleBody } from "@scfloworg/module";
import manifest from "../module.yaml";
import { ACTIONS } from "./actions/index.js";

/** The body of each action, by its name: the part of its id after the slash. */
const actions: Record<string, ModuleBody> = {};
for (const action of ACTIONS) {
  actions[action.id.slice(action.id.indexOf("/") + 1)] = action.execute.bind(action);
}

export default defineModule(manifest, { actions });
