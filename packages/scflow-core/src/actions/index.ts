import type { ActionAccess, ScflowActionDefinition } from "./params.js";
import { ACTOR_ACTIONS } from "./actors.js";
import { CONVERSION_ACTIONS } from "./conversions.js";
import { FLOW_ACTIONS } from "./flows.js";
import { INSPECT_ACTIONS } from "./inspect.js";
import { ITEM_ACTIONS } from "./items.js";
import { NOTE_ACTIONS } from "./notes.js";
import { TAG_ACTIONS } from "./tags.js";
import { TRANSFORMATION_ACTIONS } from "./transformations.js";

/** Any model action of the package, whatever its parameters and its result. */
export type ScflowAction = ScflowActionDefinition<any, any>;

/**
 * The model actions of `scflow-core`, in catalog order (topic `scflow/actions`).
 *
 * The package exports them as data. Their bodies reach an environment through
 * the bundle of the module (`src/module.ts`), and their declarations through
 * `module.yaml`, which a test keeps in agreement.
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

/**
 * The body of each action, by its name: the part of its id after the slash, in
 * the form `defineModule` of `@scfloworg/module` takes: the context, then the parameters.
 */
export const ACTION_BODIES: Record<string, (context: ActionAccess, params: unknown) => unknown> = Object.fromEntries(
  ACTIONS.map((action) => [
    action.id.slice(action.id.indexOf("/") + 1),
    (context: ActionAccess, params: unknown) => action.run(params, context),
  ]),
);

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
