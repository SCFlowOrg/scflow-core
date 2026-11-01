import type { ModelActionDefinition } from "@scfloworg/core";
import { ACTOR_ACTIONS } from "./actors.js";
import { CONVERSION_ACTIONS } from "./conversions.js";
import { FLOW_ACTIONS } from "./flows.js";
import { INSPECT_ACTIONS } from "./inspect.js";
import { ITEM_ACTIONS } from "./items.js";
import { NOTE_ACTIONS } from "./notes.js";
import { TAG_ACTIONS } from "./tags.js";
import { TRANSFORMATION_ACTIONS } from "./transformations.js";

/** Any model action of the package, whatever its parameters and its result. */
export type ScflowAction = ModelActionDefinition<any, any>;

/**
 * The model actions of `scflow-core`, in catalog order (`docs/actions.md`).
 *
 * The package exports them as data. The host registers them on its runtime, for
 * example with `registerModelActions(ACTIONS)` in `@scfloworg/core-plugin-core`.
 */
export const ACTIONS: readonly ScflowAction[] = [
  ...ACTOR_ACTIONS,
  ...FLOW_ACTIONS,
  ...ITEM_ACTIONS,
  ...TRANSFORMATION_ACTIONS,
  ...CONVERSION_ACTIONS,
  ...NOTE_ACTIONS,
  ...TAG_ACTIONS,
  ...INSPECT_ACTIONS,
];

export type {
  ActorSummary,
  ActorTypeSummary,
  CreateActorParams,
  CreateActorTypeParams,
  CreateScopeParams,
  DeleteActorParams,
  DeleteActorTypeParams,
  DeleteScopeParams,
  ScopeSummary,
  UpdateActorParams,
} from "./actors.js";
export type {
  ConversionSummary,
  CreateConversionParams,
  DeleteConversionParams,
  UpdateConversionParams,
} from "./conversions.js";
export type { CreateFlowParams, DeleteFlowParams, FlowSummary, SetFlowItemParams, UpdateFlowParams } from "./flows.js";
export type { DeleteImpactResult, DeleteTargetSchema, InspectDeleteImpactParams } from "./inspect.js";
export type {
  CreateItemParams,
  CreateItemTypeParams,
  DeleteItemParams,
  DeleteItemTypeParams,
  HeldItemSummary,
  HoldItemParams,
  ItemSummary,
  ItemTypeSummary,
  ReleaseHeldItemParams,
  UpdateItemParams,
} from "./items.js";
export type {
  AddNoteParams,
  FindNotesParams,
  NoteSummary,
  RemoveNoteParams,
  UpdateNoteParams,
} from "./notes.js";
export type { AddTagsParams, RemoveTagsParams, TaggedSummary } from "./tags.js";
export type {
  ConnectTransformationLineParams,
  CreateTransformationParams,
  CreateTransformationTypeParams,
  DefineProcessParams,
  DefinedProcess,
  DeleteTransformationParams,
  DeleteTransformationTypeParams,
  TransformationLineSummary,
  TransformationSummary,
  TransformationTypeSummary,
} from "./transformations.js";
