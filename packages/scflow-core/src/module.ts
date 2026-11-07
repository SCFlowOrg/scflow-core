/// <reference types="@scfloworg/module/yaml" />
// The entry of the bundle of the module scflow:core, built to dist/module.js
// by scripts/build-module.mjs (see docs/spec/implementation.md, Schemas
// Package). It is not compiled by tsc -b: tsconfig.module.json type-checks it.
import type { MclAccess } from "@scfloworg/core";
import { defineModule, type ModuleBody } from "@scfloworg/module";
import manifest from "../module.yaml";
import { ACTIONS } from "./actions/index.js";

/**
 * The part of the context of an action (`ActionContext` of
 * `@scfloworg/environment`) the actions of this package use: an `MclAccess`
 * and the locator of the dataset the action runs on.
 */
type Context = MclAccess & { readonly locator: string };

/**
 * The body of each action, by its name: the part of its id after the slash. A
 * body takes the context of the action and its parameters, and runs the
 * `execute` of the action on the dataset of the context.
 */
const actions: Record<string, ModuleBody> = {};
for (const action of ACTIONS) {
  actions[action.id.slice(action.id.indexOf("/") + 1)] = (context: Context, params: unknown) =>
    action.execute(context, context.locator, params as never);
}

export default defineModule(manifest, { actions });
