/**
 * The public surface of `@scfloworg/cli`: the REPL state and dataset
 * contexts, the input loop, the meta-command and command-block handlers, and
 * the command-line parsing. `docs/commands.md` describes what a user types.
 */

export { createReplState, currentContext } from "./state.js";
export type { ReplState, DatasetContext } from "./state.js";

export type { LineSource, Output } from "./io.js";

export { describeError } from "./errors.js";
export { expandSnippets } from "./snippets.js";
export { runCommandBlock, summarizeResult } from "./commandBlock.js";
export { handleMeta, tokenizeMetaLine } from "./meta.js";
export type { MetaOutcome } from "./meta.js";
export { runRepl } from "./repl.js";

export {
  registerOpenContext,
  resolveDatasetName,
  resolveUpgradeSource,
  openDatasetContext,
  createDatasetContext,
  uploadDatasetContext,
  createUpgradeContext,
  commitUpgradeContext,
  discardUpgradeContext,
} from "./datasets.js";

export { parseCliArgs, cliHelpLines } from "./cliArgs.js";
export type { CliArgs } from "./cliArgs.js";
