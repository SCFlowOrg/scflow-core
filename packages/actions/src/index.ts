/**
 * `@scfloworg/actions`, the neutral action package: the action type aligned on
 * MCP tools, the check of parameters by a JSON Schema validator, a registry,
 * the batches made only of calls, the export to AI tools and the run log. It
 * depends on no other SCFlow package; the engine plugs in what needs a dataset
 * (see `docs/actions.md`).
 */
export type {
  Action,
  ActionDefinition,
  JsonSchema,
  RefMatches,
  RefResolver,
  RunEntry,
  RunHost,
  RunOutcome,
  RunStep,
  RunTrace,
} from "./types.js";
export { ActionError, ActionErrorCode, actionError, errorCodeOf } from "./errors.js";
export type { ActionErrorCodeName } from "./errors.js";
export { canonicalJson } from "./json.js";
export { compileParameters, parametersSchema, validateParameters } from "./parameters.js";
export { createActionRegistry, createRunLog, entryOfRefusal } from "./registry.js";
export type { ActionRegistry, RunLog } from "./registry.js";
export { runBatch } from "./batch.js";
export type { Batch, BatchCall, BatchOutcome } from "./batch.js";
export { actionIdOfTool, toAiTool, toAiTools, toolName } from "./tools.js";
export type { AiTool } from "./tools.js";
