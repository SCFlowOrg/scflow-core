import {
  ModelError,
  createUpgradeLocator,
  deleteDataset,
  initDataset,
  queryDataset,
  queryUpgradeLocator,
  restoreDataset,
  upgradeDataset,
} from "@scfloworg/core";
import type { CommandResult, RestoreResult, TransientObject } from "@scfloworg/core";
import type { DatasetContext, ReplState } from "./state.js";

/**
 * Registers `name` in `state`, opening a `ScriptSession` on `locator` through
 * `state.apiSession`. This is the last step of every path that gets a dataset
 * (`openDatasetContext`, `createDatasetContext`, `uploadDatasetContext`), once
 * each has decided what `name` is. A caller that must change the dataset
 * before the session opens uses it directly: the schemas and scalar types of a
 * locator are cached by whichever call touches the locator first, so anything
 * that should be visible has to happen before.
 *
 * Going through `state.apiSession` shares a locator's schemas and scalar types
 * across every context opened on it in this process; each context still gets
 * its own `ScriptSession`, hence its own `variables` map.
 *
 * A `name` already in `state` is overwritten, not refused, and `overwrote`
 * tells the caller so it can warn. `currentName` is untouched when the
 * overwritten context was the current one: it keeps pointing at the new
 * context under the same name.
 *
 * @param upgradeOf - the source locator when `locator` is an upgrade locator, otherwise `null`.
 */
export async function registerOpenContext(
  state: ReplState,
  name: string,
  locator: string,
  upgradeOf: string | null = null,
): Promise<{ ctx: DatasetContext; overwrote: boolean }> {
  const overwrote = state.contexts.has(name);
  const session = await state.apiSession.createScriptSession(locator);
  const ctx: DatasetContext = { name, locator, session, history: [], upgradeOf };
  state.contexts.set(name, ctx);
  if (state.currentName === null) state.currentName = name;
  return { ctx, overwrote };
}

/**
 * The source locator that `locator` holds a model upgrade for, or `null` when
 * `locator` is an ordinary dataset. `queryUpgradeLocator` throws
 * `not_upgrade_locator` for an ordinary dataset, which is the common case, so
 * that one code becomes `null`; any other failure propagates.
 */
export async function resolveUpgradeSource(locator: string): Promise<string | null> {
  try {
    const { source_locator } = await queryUpgradeLocator(locator);
    return source_locator;
  } catch (err) {
    if (err instanceof ModelError && err.code === "not_upgrade_locator") return null;
    throw err;
  }
}

/**
 * The `name` stored on the dataset at `locator`; every dataset has one.
 *
 * @throws `Error` when `locator` resolves to no dataset, or its `name` is not a string.
 */
export async function resolveDatasetName(locator: string): Promise<string> {
  const info = await queryDataset(locator);
  if (info === null) {
    throw new Error(`no dataset at "${locator}" to open`);
  }
  const name = (info as TransientObject).name;
  if (typeof name !== "string") {
    throw new Error(`dataset at "${locator}" has no usable "name" to open it under`);
  }
  return name;
}

/**
 * Opens a dataset that already exists, under its own stored `name`. An upgrade
 * locator opens like any other dataset and carries its source locator into the
 * context, so `changes`, `check`, `commit` and `discard` work on it even in a
 * process that did not create it.
 */
export async function openDatasetContext(state: ReplState, locator: string): Promise<{ ctx: DatasetContext; overwrote: boolean }> {
  const name = await resolveDatasetName(locator);
  const upgradeOf = await resolveUpgradeSource(locator);
  return registerOpenContext(state, name, locator, upgradeOf);
}

/**
 * Creates an upgrade locator for the dataset at `sourceLocator` and opens it as
 * its own context, under the name `createUpgradeLocator` gave the temporary
 * dataset (`<source name> (upgrade)`). Model commands run against that
 * context; `commitUpgradeContext` applies them and `discardUpgradeContext`
 * throws them away.
 */
export async function createUpgradeContext(state: ReplState, sourceLocator: string): Promise<{ ctx: DatasetContext; overwrote: boolean }> {
  const upgradeLocator = await createUpgradeLocator(sourceLocator);
  const name = await resolveDatasetName(upgradeLocator);
  return registerOpenContext(state, name, upgradeLocator, sourceLocator);
}

/**
 * Applies the model changes recorded in `ctx` to the dataset it was created
 * for, then drops the context, because `upgradeDataset` deletes the upgrade
 * locator's own dataset on success.
 *
 * The cached schemas and scalar types of the source locator are invalidated,
 * so a context already open on it runs its next command against the new model
 * instead of the cached one. The upgrade locator's own entry goes too: its
 * dataset is gone.
 *
 * @throws `Error` when `ctx` is not an upgrade context.
 */
export async function commitUpgradeContext(state: ReplState, ctx: DatasetContext): Promise<{ result: CommandResult; sourceLocator: string }> {
  const sourceLocator = ctx.upgradeOf;
  if (sourceLocator === null) throw new Error(`"${ctx.name}" is not an upgrade context`);
  const result = await upgradeDataset(sourceLocator, ctx.locator);
  state.apiSession.invalidate(sourceLocator);
  state.apiSession.invalidate(ctx.locator);
  forgetContext(state, ctx);
  return { result, sourceLocator };
}

/**
 * Deletes the upgrade dataset of `ctx`, changes and all, and drops the context.
 *
 * @throws `Error` when `ctx` is not an upgrade context.
 */
export async function discardUpgradeContext(state: ReplState, ctx: DatasetContext): Promise<void> {
  if (ctx.upgradeOf === null) throw new Error(`"${ctx.name}" is not an upgrade context`);
  await deleteDataset(ctx.locator);
  state.apiSession.invalidate(ctx.locator);
  forgetContext(state, ctx);
}

/**
 * Removes `ctx` from the session. `currentName` moves to the context open on
 * `ctx.upgradeOf` when there is one, since after a `commit` the user wants to
 * be on the dataset just upgraded; otherwise to any remaining context, or to
 * `null` when `ctx` was the last one.
 */
function forgetContext(state: ReplState, ctx: DatasetContext): void {
  state.contexts.delete(ctx.name);
  if (state.currentName !== ctx.name) return;
  const successor =
    [...state.contexts.values()].find((c) => c.locator === ctx.upgradeOf) ?? [...state.contexts.values()][0];
  state.currentName = successor ? successor.name : null;
}

/**
 * Creates a dataset at `locator`, named `name`, and opens it under that name.
 *
 * @throws `dataset_already_exists` when `locator` already holds a dataset.
 */
export async function createDatasetContext(state: ReplState, locator: string, name: string): Promise<{ ctx: DatasetContext; overwrote: boolean }> {
  await initDataset(locator, name);
  return registerOpenContext(state, name, locator);
}

/**
 * Populates a new dataset at `locator` from a `dumpDataset` snapshot with
 * `restoreDataset`, then opens it under the dump's own dataset name.
 *
 * @param dump - the snapshot text.
 * @param format - the format of `dump`.
 * @throws `dataset_already_exists` when `locator` already holds a dataset;
 * `Error` when the restored dataset has no usable name.
 */
export async function uploadDatasetContext(
  state: ReplState,
  locator: string,
  dump: string,
  format: "json" | "yaml",
): Promise<{ ctx: DatasetContext; result: RestoreResult; overwrote: boolean }> {
  const result = await restoreDataset(locator, dump, format);
  const name = (result.dataset as TransientObject).name;
  if (typeof name !== "string") {
    throw new Error(`dataset restored at "${locator}" has no usable "name" to open it under`);
  }
  const { ctx, overwrote } = await registerOpenContext(state, name, locator);
  return { ctx, result, overwrote };
}
