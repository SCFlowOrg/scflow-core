import { SCALAR_TYPES, SCHEMA_LIST } from "./schemas.generated.js";

export { createActor } from "./actors.js";
export type { CreateActorInput } from "./actors.js";
export { createFlow, getCommonFlowDomains, setFlowItem } from "./flows.js";
export type { CreateFlowInput, FlowEndsInput, SetFlowItemInput } from "./flows.js";
export { ACTIONS } from "./actions/index.js";
export type {
  ActorSummary,
  ActorTypeSummary,
  AddNoteParams,
  ConnectTransformationLineParams,
  ConversionSummary,
  CreateActorParams,
  CreateActorTypeParams,
  CreateConversionParams,
  CreateFlowParams,
  CreateItemParams,
  CreateItemTypeParams,
  CreateScopeParams,
  CreateTransformationParams,
  CreateTransformationTypeParams,
  DefineProcessParams,
  DefinedProcess,
  DeleteActorParams,
  DeleteActorTypeParams,
  DeleteConversionParams,
  DeleteFlowParams,
  DeleteImpactResult,
  DeleteItemParams,
  DeleteItemTypeParams,
  DeleteScopeParams,
  DeleteTargetSchema,
  DeleteTransformationParams,
  DeleteTransformationTypeParams,
  FindNotesParams,
  FlowSummary,
  HeldItemSummary,
  HoldItemParams,
  InspectDeleteImpactParams,
  ItemSummary,
  ItemTypeSummary,
  NoteSummary,
  ReleaseHeldItemParams,
  RemoveNoteParams,
  ScflowAction,
  ScopeSummary,
  SetFlowItemParams,
  TransformationLineSummary,
  TransformationSummary,
  TransformationTypeSummary,
  UpdateActorParams,
  UpdateConversionParams,
  UpdateItemParams,
  UpdateNoteParams,
} from "./actions/index.js";

/**
 * The SCFLOW scalar types and schemas, compiled from the manifest `module.yaml`.
 * Structurally a `SchemaPackage` of core-plugin, without importing it.
 */
export const SCHEMAS: {
  scalar_types: Record<string, unknown>[];
  schemas: Record<string, unknown>[];
} = {
  scalar_types: SCALAR_TYPES,
  schemas: SCHEMA_LIST,
};
