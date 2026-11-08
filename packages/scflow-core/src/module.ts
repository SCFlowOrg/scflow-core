/// <reference types="@scfloworg/module/yaml" />
// The entry of the bundle of the module scflow:core, built to dist/module.js
// by scripts/build-module.mjs (see docs/spec/implementation.md, Schemas
// Package). It is not compiled by tsc -b: tsconfig.module.json type-checks it.
import { defineModule, type ModuleBody } from "@scfloworg/module";
import manifest from "../module.yaml";
import { ACTION_BODIES } from "./actions/index.js";

// A body takes the context of the action and its parameters, as an environment
// calls it (`ActionContext` of `@scfloworg/environment`), and runs the action.
export default defineModule(manifest, { actions: ACTION_BODIES as Record<string, ModuleBody> });
