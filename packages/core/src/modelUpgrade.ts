import { modelError } from "./errors.js";
import { addedProperties, extensionOfProperty, extensionRelationOf } from "./extensions.js";
import { checkFilter, matchFilter } from "./filter.js";
import type { Resolvers } from "./resolvers.js";
import { NO_ROLES, SCHEMA_ROLES, processScalarTypeDescription, processSchemaDescription } from "./schemaProcessing.js";
import type {
  Command,
  CommandResult,
  NormalizedProperty,
  NormalizedScalarType,
  NormalizedSchema,
  PersistenceInterface,
  TransientObject,
  TransientValue,
} from "./types.js";

/**
 * Shared internals for changing a dataset's model (`schema`/`scalar_type`)
 * through an upgrade locator, per document_part-definition-model_upgrade.md
 * and `docs/model-upgrade.md`.
 *
 * Split out from command.ts/api.ts so command.ts's engine (the single choke
 * point `runCommand`/`runScript`/`createScriptSession` all funnel through,
 * per script.ts) can gate `schema`/`scalar_type` changes behind an upgrade
 * locator in one place, while api.ts's `createUpgradeLocator`/
 * `queryUpgradeLocator`/`checkUpgrade`/`upgradeDataset` reuse the same
 * marker/snapshot/diff plumbing. Nothing here imports from command.ts or
 * api.ts, to keep the dependency direction one-way (command.ts -> here).
 */

export function clone<T extends TransientValue>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

// ---------------------------------------------------------------------------
// `schema` / `scalar_type` are the only two model-level entities, per
// the `schema_processing` part — `property` has no add call of
// its own (always embedded in a schema's `properties`). `dataset` is NOT a
// model schema: it's a singleton data instance, and renaming it (the only
// writable operation) is a data change, not a model change.
// ---------------------------------------------------------------------------

/** Whether `name` is a model-level schema, `schema` or `scalar_type`: a command on it goes through an upgrade locator. `dataset` is not one. */
export function isModelSchema(name: string): boolean {
  return name === "schema" || name === "scalar_type";
}

// ---------------------------------------------------------------------------
// Upgrade locator marker + snapshot — stored as ordinary instances of two
// internal-only schemas in the upgrade dataset itself (never exposed through
// `runCommand`/`runScript`, since callers only ever address `schema`/
// `scalar_type`/user schemas by name). This makes "is `rest` an upgrade
// locator" resolvable purely from the dataset's own storage, per
// document_part-definition-persistence_interface.md's "a schema, scalar_type
// or import is not special storage-wise" — an upgrade marker isn't either.
// An in-memory registry (module-scoped Map, like the persistent-format
// registry in api.ts) was the other option; this one survives independently
// of process lifetime for any format, at the cost of two extra stored
// instances per upgrade locator. Flagged in scaffoldplan-log.md.
// ---------------------------------------------------------------------------

const UPGRADE_MARKER_SCHEMA = "__upgrade_locator__";
const UPGRADE_MARKER_KEY = "self";
const UPGRADE_SNAPSHOT_SCHEMA = "__upgrade_snapshot__";
const UPGRADE_SNAPSHOT_KEY = "self";

/** Stored in an upgrade locator's own dataset to mark it as one and to record what it is for. */
export interface UpgradeMarker {
  /** The locator this upgrade locator was created for. */
  source_locator: string;
  /** The import namespace this upgrade locator was created for: always "", the dataset's own model. */
  namespace: string;
}

export async function getUpgradeMarker(impl: PersistenceInterface, rest: string): Promise<UpgradeMarker | null> {
  const raw = await impl.getInstance(rest, UPGRADE_MARKER_SCHEMA, UPGRADE_MARKER_KEY, NO_ROLES);
  return raw === null ? null : (raw as unknown as UpgradeMarker);
}

export async function setUpgradeMarker(impl: PersistenceInterface, rest: string, marker: UpgradeMarker): Promise<void> {
  await impl.putInstance(rest, UPGRADE_MARKER_SCHEMA, UPGRADE_MARKER_KEY, marker as unknown as TransientValue, NO_ROLES);
}

export interface UpgradeSnapshot {
  /** The model as it stood the moment `createUpgradeLocator` was called — never mutated afterward. */
  schemas: Record<string, NormalizedSchema>;
  scalar_types: Record<string, NormalizedScalarType>;
}

export async function getUpgradeSnapshot(impl: PersistenceInterface, rest: string): Promise<UpgradeSnapshot | null> {
  const raw = await impl.getInstance(rest, UPGRADE_SNAPSHOT_SCHEMA, UPGRADE_SNAPSHOT_KEY, NO_ROLES);
  return raw === null ? null : (raw as unknown as UpgradeSnapshot);
}

export async function setUpgradeSnapshot(impl: PersistenceInterface, rest: string, snapshot: UpgradeSnapshot): Promise<void> {
  await impl.putInstance(rest, UPGRADE_SNAPSHOT_SCHEMA, UPGRADE_SNAPSHOT_KEY, snapshot as unknown as TransientValue, NO_ROLES);
}

// ---------------------------------------------------------------------------
// Applying a virtual inverse relation, moved here unchanged (aside from the
// new `acc` param) from api.ts's old addSchema/updateSchema — see
// document_part-feature-schema_processing.md's "Virtual relations".
// ---------------------------------------------------------------------------

/**
 * Whether `prop` is inherited rather than declared by `schema` — that is,
 * whether an ancestor reached through `extends` already declares a property
 * of the same name carrying the same `inverse_name`.
 *
 * Schema Processing flattens `extends` into a single property list, so a
 * schema extending one that declares a relation carries that relation among
 * its own properties. Generating the inverse for it as well rewrites the
 * target schema's property, retyped to the extending schema, and the last
 * schema ingested wins. The inverse is generated once, on behalf of the
 * schema that declares the relation: an instance of any extending schema is
 * an instance of that schema too, so the single generated property accepts
 * all of them.
 */
async function isInheritedRelation(
  impl: PersistenceInterface,
  rest: string,
  schemas: Map<string, NormalizedSchema>,
  schema: NormalizedSchema,
  prop: NormalizedProperty,
): Promise<boolean> {
  const seen = new Set<string>([schema.name]);
  let current: string | null = schema.extends;
  while (current !== null && !seen.has(current)) {
    seen.add(current);
    let ancestor = schemas.get(current);
    if (!ancestor) {
      const raw = await impl.getInstance(rest, "schema", current, SCHEMA_ROLES);
      if (raw) ancestor = raw as unknown as NormalizedSchema;
    }
    if (!ancestor) return false;
    const inherited = ancestor.properties.find((p) => p.name === prop.name);
    if (inherited && inherited.constraints.inverse_name === prop.constraints.inverse_name) return true;
    current = ancestor.extends;
  }
  return false;
}

/**
 * Generates, on the target schema of each `inverse_name` relation of `schema`,
 * the virtual inverse relation. The target is looked up in `schemas`, then in
 * storage: it must already be registered, so a caller creating several schemas
 * registers all of them before applying the inverse relations of any.
 * Throws `unknown_extends_target` when a target is found in neither, and
 * `inverse_name_conflict` when the target already has a non-generated property
 * of that name.
 */
export async function applyInverseRelations(
  impl: PersistenceInterface,
  rest: string,
  schemas: Map<string, NormalizedSchema>,
  schema: NormalizedSchema,
  acc?: { updatedBefore: TransientValue[]; updatedAfter: TransientValue[] },
): Promise<void> {
  for (const prop of schema.properties) {
    const inverseName = prop.constraints.inverse_name;
    if (typeof inverseName !== "string") continue;
    if (await isInheritedRelation(impl, rest, schemas, schema, prop)) continue;
    const targetName = prop.type;
    let target = schemas.get(targetName);
    if (!target) {
      const raw = await impl.getInstance(rest, "schema", targetName, SCHEMA_ROLES);
      if (raw) target = raw as unknown as NormalizedSchema;
    }
    if (!target) {
      throw modelError("unknown_extends_target", `inverse relation on "${schema.name}.${prop.name}" targets unknown schema "${targetName}"`);
    }

    const existing = target.properties.find((p) => p.name === inverseName);
    if (existing && existing.constraints.__generated !== true) {
      throw modelError("inverse_name_conflict", `"${inverseName}" already exists on "${target.name}" and is not a generated inverse relation`);
    }

    const before = acc && target.name !== schema.name ? clone(target as unknown as TransientValue) : null;

    const targetProperties = target.properties.filter((p) => p.name !== inverseName);

    const virtualProp: NormalizedProperty = {
      name: inverseName,
      type: schema.name,
      default_value: null,
      null_value: null,
      constraints: {
        is_array: prop.constraints.inverse_is_array === true,
        mandatory: prop.constraints.inverse_is_mandatory === true,
        // A relation declared `owns` (rather than `owner`) puts the ownership
        // flag on the *declaring* side — document_part-concept-ownership.md's
        // "Ownership goes through Relations with the owns or owner
        // constraints" treats the two as equivalent, so the generated inverse
        // needs `owner: true` here for ownerProperties (schema.ts) to
        // recognize it: without this, an `owns`-declared relation never
        // actually established ownership on its target at all — cascade
        // deletion, "must have an owner at creation", none of it fired.
        // `owner: false` (rather than simply omitting the key) is what an
        // `owner`-declared relation's own generated inverse already got
        // implicitly; setting it explicitly either way keeps the two paths
        // symmetric.
        owner: prop.constraints.owns === true,
        __generated: true,
      },
    };
    const updatedTarget: NormalizedSchema = {
      ...target,
      properties: [...targetProperties, virtualProp],
    };
    await impl.putInstance(rest, "schema", target.name, updatedTarget as unknown as TransientValue, SCHEMA_ROLES);
    schemas.set(target.name, updatedTarget);

    // Schema Processing flattened `extends` when each extending schema was ingested, so a schema
    // of the same command that extends the target was flattened before the inverse existed: it
    // receives the generated property too, as one created after the inverse would.
    for (const extender of withExtendingSchemas(schemas, updatedTarget).slice(1)) {
      const present = extender.properties.find((p) => p.name === inverseName);
      if (present) {
        if (present.constraints.__generated !== true) {
          throw modelError("inverse_name_conflict", `"${inverseName}" already exists on "${extender.name}" and is not a generated inverse relation`);
        }
        continue;
      }
      const updatedExtender: NormalizedSchema = { ...extender, properties: [...extender.properties, virtualProp] };
      await impl.putInstance(rest, "schema", extender.name, updatedExtender as unknown as TransientValue, SCHEMA_ROLES);
      schemas.set(extender.name, updatedExtender);
      if (acc) {
        acc.updatedBefore.push(clone(extender as unknown as TransientValue));
        acc.updatedAfter.push(clone(updatedExtender as unknown as TransientValue));
      }
    }

    if (acc && before) {
      acc.updatedBefore.push(before);
      acc.updatedAfter.push(clone(updatedTarget as unknown as TransientValue));
    }
  }
}

/** `target` and every schema extending it, directly or through further extension. */
function withExtendingSchemas(schemas: Map<string, NormalizedSchema>, target: NormalizedSchema): NormalizedSchema[] {
  const result = [target];
  for (const candidate of schemas.values()) {
    if (candidate.name === target.name) continue;
    const seen = new Set<string>([candidate.name]);
    let current = candidate.extends;
    while (current !== null && !seen.has(current)) {
      if (current === target.name) {
        result.push(candidate);
        break;
      }
      seen.add(current);
      current = schemas.get(current)?.extends ?? null;
    }
  }
  return result;
}

/**
 * Stores `updated` schemas and registers them in `schemas`; a schema other than
 * `except` that really changed is reported in `acc`, as `applyInverseRelations`
 * does for the target of an inverse relation.
 */
async function storeChangedSchemas(
  impl: PersistenceInterface,
  rest: string,
  schemas: Map<string, NormalizedSchema>,
  updated: Map<string, NormalizedSchema>,
  except: string,
  acc?: { updatedBefore: TransientValue[]; updatedAfter: TransientValue[] },
): Promise<void> {
  for (const [name, next] of updated) {
    const previous = schemas.get(name) as NormalizedSchema;
    if (JSON.stringify(previous) === JSON.stringify(next)) continue;
    if (acc && name !== except) {
      acc.updatedBefore.push(clone(previous as unknown as TransientValue));
      acc.updatedAfter.push(clone(next as unknown as TransientValue));
    }
    await impl.putInstance(rest, "schema", name, next as unknown as TransientValue, SCHEMA_ROLES);
    schemas.set(name, next);
  }
}

/** The copies of every schema that carries properties generated by the extension `extensionName`, those properties removed. */
function schemasWithoutExtension(schemas: Map<string, NormalizedSchema>, extensionName: string): Map<string, NormalizedSchema> {
  const stripped = new Map<string, NormalizedSchema>();
  for (const schema of schemas.values()) {
    if (schema.properties.some((p) => extensionOfProperty(p) === extensionName)) {
      stripped.set(schema.name, { ...schema, properties: schema.properties.filter((p) => extensionOfProperty(p) !== extensionName) });
    }
  }
  return stripped;
}

/**
 * Removes from every schema the properties generated by the extension
 * `extensionName`, once the extension schema is deleted or no longer an
 * extension. Stores the schemas it changes.
 */
export async function dropExtensionProperties(
  impl: PersistenceInterface,
  rest: string,
  schemas: Map<string, NormalizedSchema>,
  extensionName: string,
  acc?: { updatedBefore: TransientValue[]; updatedAfter: TransientValue[] },
): Promise<void> {
  await storeChangedSchemas(impl, rest, schemas, schemasWithoutExtension(schemas, extensionName), extensionName, acc);
}

/**
 * Applies what `schema` means for the extensions of the model. A relation of
 * `schema` that targets an extension schema, and a relation of any schema that
 * targets `schema` when it is one, throw `constraint_violation`: the instances
 * of an extension schema are reached only through the schema it extends.
 * When `schema` is an extension schema, its properties other than the
 * `extension` relation are generated on the target and on every schema
 * extending it, each tagged by `__extension` with the name of `schema`, after
 * whatever `schema` generated earlier is removed. A property of the same name
 * already on one of those schemas, whether its own, a generated inverse or a
 * property of another extension, throws `constraint_violation`. A target found
 * neither in `schemas` nor in storage throws `unknown_extends_target`, and a
 * target that is itself an extension schema or embedded throws
 * `constraint_violation`. Nothing is stored when it throws. See the part
 * `schema_processing` (*Extensions*) of the document `model`.
 */
export async function applyExtensions(
  impl: PersistenceInterface,
  rest: string,
  schemas: Map<string, NormalizedSchema>,
  schema: NormalizedSchema,
  acc?: { updatedBefore: TransientValue[]; updatedAfter: TransientValue[] },
): Promise<void> {
  for (const prop of schema.properties) {
    if (prop.constraints.__generated === true) continue;
    const related = schemas.get(prop.type);
    if (related && related.name !== schema.name && extensionRelationOf(related)) {
      throw modelError("constraint_violation", `"${schema.name}.${prop.name}" targets "${related.name}", an extension schema — its instances are reached only through the schema it extends`);
    }
  }

  const relation = extensionRelationOf(schema);
  const updated = schemasWithoutExtension(schemas, schema.name);
  if (relation) {
    for (const other of schemas.values()) {
      const targeting = other.properties.find((p) => p.type === schema.name);
      if (other.name !== schema.name && targeting) {
        throw modelError("constraint_violation", `"${other.name}.${targeting.name}" targets "${schema.name}", an extension schema — its instances are reached only through the schema it extends`);
      }
    }
    let target = schemas.get(relation.type);
    if (!target) {
      const raw = await impl.getInstance(rest, "schema", relation.type, SCHEMA_ROLES);
      if (raw) {
        target = raw as unknown as NormalizedSchema;
        schemas.set(target.name, target);
      }
    }
    if (!target) {
      throw modelError("unknown_extends_target", `extension schema "${schema.name}" extends unknown schema "${relation.type}"`);
    }
    if (extensionRelationOf(target)) {
      throw modelError("constraint_violation", `extension schema "${schema.name}" extends "${target.name}", which is itself an extension schema`);
    }
    if (target.constraints.embedded === true) {
      throw modelError("constraint_violation", `extension schema "${schema.name}" extends "${target.name}", which is embedded and has no key to share`);
    }

    const added = addedProperties(schema);
    for (const holder of withExtendingSchemas(schemas, target)) {
      const base = updated.get(holder.name) ?? holder;
      for (const prop of added) {
        const clash = base.properties.find((p) => p.name === prop.name);
        if (clash) {
          const owner = extensionOfProperty(clash);
          throw modelError(
            "constraint_violation",
            `property "${prop.name}" of extension "${schema.name}" is already a property of "${holder.name}"${owner ? ` through the extension "${owner}"` : ""}`,
          );
        }
      }
      const generated = added.map((p) => clone({ ...p, constraints: { ...p.constraints, __extension: schema.name } } as unknown as TransientValue) as unknown as NormalizedProperty);
      updated.set(holder.name, { ...base, properties: [...base.properties, ...generated] });
    }
  }

  await storeChangedSchemas(impl, rest, schemas, updated, schema.name, acc);
}

function itemName(item: TransientValue): string | undefined {
  if (item !== null && typeof item === "object" && !Array.isArray(item)) {
    const name = (item as TransientObject).name;
    return typeof name === "string" ? name : undefined;
  }
  return undefined;
}

/**
 * Runs a `create`/`update`/`delete` command targeting `schema` or
 * `scalar_type` against an upgrade dataset (`rest`) — the counterpart to
 * command.ts's generic `runCommand` for ordinary data schemas. The caller
 * (command.ts's `runCommand`) has already confirmed `rest` is an upgrade
 * locator and that `command.kind !== "query"` before calling this.
 *
 * Unlike a generic instance, `schema`/`scalar_type` go through Schema
 * Processing (`processSchemaDescription`/`processScalarTypeDescription`)
 * rather than the ordinary computePropertyValue/validateInstance pass — the
 * authored form is sugared (arbitrary keys become `constraints`, `properties`
 * entries are themselves sugared) in a way generic command processing never
 * had to handle for other schemas. `update`'s `input` item is treated as a
 * full replacement description (not a property-by-property patch) since a
 * schema's `properties` list is a whole structure, not a set of independent
 * scalar fields — the same behavior the old `updateSchema` had.
 *
 * A `create` of several schemas stores and registers all of them before it
 * generates any inverse relation, so the target of an `inverse_name` relation
 * may be a schema of the same command, placed before or after the declaring
 * one, or the declaring schema itself. A target found neither in the command
 * nor in the model throws `unknown_extends_target`. The `after` of the result
 * lists the schemas with the inverse properties generated on them. An `update`
 * keeps the inverse properties generated on a schema, including those generated
 * by another entry of the same command.
 */
export async function runSchemaCommand(impl: PersistenceInterface, rest: string, command: Command, resolvers: Resolvers): Promise<CommandResult> {
  const acc = { updatedBefore: [] as TransientValue[], updatedAfter: [] as TransientValue[] };

  if (command.schema === "scalar_type") {
    if (command.kind === "update" || command.kind === "delete") {
      throw modelError("constraint_violation", `"scalar_type" is constant — ${command.kind} is not supported, only create`);
    }
    const after: TransientValue[] = [];
    for (const item of command.input ?? []) {
      const name = itemName(item);
      if (typeof name === "string" && resolvers.scalarTypes.has(name)) {
        throw modelError("duplicate_name", `scalar type "${name}" already exists`);
      }
      const normalized = processScalarTypeDescription(item, resolvers.ctx.resolveScalarType);
      await impl.putInstance(rest, "scalar_type", normalized.name, normalized as unknown as TransientValue, NO_ROLES);
      resolvers.scalarTypes.set(normalized.name, normalized);
      after.push(clone(normalized as unknown as TransientValue));
    }
    return { before: [], after, "cascade-deleted": [], "updated-before": acc.updatedBefore, "updated-after": acc.updatedAfter };
  }

  // command.schema === "schema"
  const schemaMeta = resolvers.schemas.get("schema") as NormalizedSchema;

  async function findMatches(): Promise<NormalizedSchema[]> {
    const all = await impl.listInstances(rest, "schema", SCHEMA_ROLES);
    const filterCtx = { ...resolvers.ctx, impl, rest };
    checkFilter(command.filters, schemaMeta, resolvers.ctx);
    const matches: NormalizedSchema[] = [];
    for (const raw of all) {
      if (await matchFilter(raw, command.filters, schemaMeta, filterCtx)) matches.push(raw as unknown as NormalizedSchema);
    }
    return matches;
  }

  switch (command.kind) {
    case "create": {
      const created: NormalizedSchema[] = [];
      for (const item of command.input ?? []) {
        const name = itemName(item);
        if (typeof name === "string" && resolvers.schemas.has(name)) {
          throw modelError("duplicate_name", `schema "${name}" already exists`);
        }
        const normalized = processSchemaDescription(item, resolvers.ctx);
        await impl.putInstance(rest, "schema", normalized.name, normalized as unknown as TransientValue, SCHEMA_ROLES);
        resolvers.schemas.set(normalized.name, normalized);
        created.push(normalized);
      }
      // Every schema of the command is registered before the first inverse relation is
      // applied, so the target of an inverse relation may be declared later in the command.
      for (const normalized of created) {
        await applyInverseRelations(impl, rest, resolvers.schemas, normalized, acc);
      }
      // The extension properties are generated once the schemas are registered, so an extension
      // may target a schema of the same command, placed before or after it.
      for (const normalized of created) {
        await applyExtensions(impl, rest, resolvers.schemas, normalized, acc);
      }
      // Read once every inverse relation is applied: a schema of the command carries the
      // inverse properties that the other schemas of the command generate on it.
      const after: TransientValue[] = [];
      for (const normalized of created) {
        after.push(clone((await impl.getInstance(rest, "schema", normalized.name, SCHEMA_ROLES)) as TransientValue));
      }
      return { before: [], after, "cascade-deleted": [], "updated-before": acc.updatedBefore, "updated-after": acc.updatedAfter };
    }

    case "update": {
      const inputs = command.input ?? [];
      if (inputs.length === 0) throw modelError("empty_input", `update on "schema" requires input`);
      const matched = await findMatches();
      const before: TransientValue[] = [];
      const after: TransientValue[] = [];
      for (let i = 0; i < matched.length; i++) {
        const prev = matched[i];
        before.push(clone(prev as unknown as TransientValue));
        const patch = inputs[i % inputs.length];
        if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
          throw modelError("constraint_violation", "update input entries must be objects");
        }
        const normalized = processSchemaDescription({ ...(patch as TransientObject), name: prev.name }, resolvers.ctx);
        // preserve virtual properties injected by other schemas' inverse relations,
        // which the freshly-authored `patch` won't mention. They come from the current schema:
        // an earlier entry of this command may have generated one since `matched` was read.
        const current = resolvers.schemas.get(prev.name) ?? prev;
        for (const p of current.properties) {
          if (p.constraints.__generated === true && !normalized.properties.some((np) => np.name === p.name)) {
            normalized.properties.push(p);
          }
        }
        // the properties generated by the extensions of this schema are kept too, and a property
        // the new description declares under the same name is a clash
        for (const p of current.properties) {
          const extension = extensionOfProperty(p);
          if (extension === undefined) continue;
          const same = normalized.properties.find((np) => np.name === p.name);
          if (!same) {
            normalized.properties.push(p);
          } else if (extensionOfProperty(same) !== extension) {
            throw modelError("constraint_violation", `"${p.name}" on "${prev.name}" is a property of the extension "${extension}"`);
          }
        }
        await impl.putInstance(rest, "schema", normalized.name, normalized as unknown as TransientValue, SCHEMA_ROLES);
        resolvers.schemas.set(normalized.name, normalized);
        await applyInverseRelations(impl, rest, resolvers.schemas, normalized, acc);
        await applyExtensions(impl, rest, resolvers.schemas, normalized, acc);
        after.push(clone((await impl.getInstance(rest, "schema", normalized.name, SCHEMA_ROLES)) as TransientValue));
      }
      return { before, after, "cascade-deleted": [], "updated-before": acc.updatedBefore, "updated-after": acc.updatedAfter };
    }

    case "delete": {
      const matched = await findMatches();
      const before: TransientValue[] = [];
      for (const s of matched) {
        before.push(clone(s as unknown as TransientValue));
        await impl.deleteInstance(rest, "schema", s.name);
        resolvers.schemas.delete(s.name);
        await dropExtensionProperties(impl, rest, resolvers.schemas, s.name, acc);
      }
      return { before, after: [], "cascade-deleted": [], "updated-before": acc.updatedBefore, "updated-after": acc.updatedAfter };
    }

    default:
      // "query" never reaches here — command.ts only calls this for kind !== "query".
      throw modelError("constraint_violation", `unsupported kind "${command.kind}" on "schema"`);
  }
}

// ---------------------------------------------------------------------------
// Model diff — comparing an upgrade locator's frozen snapshot against its
// current (possibly edited) `schema`/`scalar_type` stores, per
// `docs/model-upgrade.md`:
// `queryUpgradeLocator` and `checkUpgrade`.
// ---------------------------------------------------------------------------

/** One schema or scalar type whose definition differs between the snapshot of an upgrade locator and its current model. */
export interface ModelDiffEntry {
  name: string;
  kind: "schema" | "scalar_type";
  /** The snapshot (pre-edit) value, or null if this entry was newly added. */
  before: TransientValue | null;
  /** The current (post-edit) value, or null if this entry was removed. */
  after: TransientValue | null;
  /** True for a schema that wasn't itself edited but transitively `extends` one that was — "considered as deleted". */
  cascaded: boolean;
}

/** The differences between an upgrade locator's snapshot and its current model, in three groups. */
export interface ModelDiff {
  /** Added or directly modified entries (`before`/`after` both meaningful, or `before: null` for an addition). */
  changed: ModelDiffEntry[];
  /** Directly deleted entries (`after: null`). */
  deleted: ModelDiffEntry[];
  /** Schemas extending a modified/deleted schema, "considered as deleted" even though their own stored definition didn't change. */
  cascadeDeleted: ModelDiffEntry[];
}

export async function computeModelDiff(impl: PersistenceInterface, rest: string): Promise<ModelDiff> {
  const snapshot = await getUpgradeSnapshot(impl, rest);
  if (!snapshot) throw modelError("not_upgrade_locator", `"${rest}" has no upgrade snapshot recorded`);

  const currentSchemas = await impl.listInstances(rest, "schema", SCHEMA_ROLES);
  const currentScalarTypes = await impl.listInstances(rest, "scalar_type", NO_ROLES);
  const currentSchemaMap = new Map<string, NormalizedSchema>(
    currentSchemas.map((s) => [(s as unknown as NormalizedSchema).name, s as unknown as NormalizedSchema]),
  );
  const currentScalarMap = new Map<string, NormalizedScalarType>(
    currentScalarTypes.map((s) => [(s as TransientObject).name as string, s as unknown as NormalizedScalarType]),
  );

  const changed: ModelDiffEntry[] = [];
  const deleted: ModelDiffEntry[] = [];
  const changedOrDeletedSchemaNames = new Set<string>();

  const schemaNames = new Set([...Object.keys(snapshot.schemas), ...currentSchemaMap.keys()]);
  for (const name of schemaNames) {
    const before = snapshot.schemas[name] ?? null;
    const after = currentSchemaMap.get(name) ?? null;
    if (before && !after) {
      deleted.push({ name, kind: "schema", before: before as unknown as TransientValue, after: null, cascaded: false });
      changedOrDeletedSchemaNames.add(name);
    } else if (!before && after) {
      changed.push({ name, kind: "schema", before: null, after: after as unknown as TransientValue, cascaded: false });
    } else if (before && after && JSON.stringify(before) !== JSON.stringify(after)) {
      changed.push({ name, kind: "schema", before: before as unknown as TransientValue, after: after as unknown as TransientValue, cascaded: false });
      changedOrDeletedSchemaNames.add(name);
    }
  }

  const scalarNames = new Set([...Object.keys(snapshot.scalar_types), ...currentScalarMap.keys()]);
  for (const name of scalarNames) {
    const before = snapshot.scalar_types[name] ?? null;
    const after = currentScalarMap.get(name) ?? null;
    // scalar_type is constant (create-only, see runSchemaCommand above) — the
    // only possible states are "added" or "unchanged"; the delete/modify
    // branches below are defensive, not reachable through the normal flow.
    if (!before && after) {
      changed.push({ name, kind: "scalar_type", before: null, after: after as unknown as TransientValue, cascaded: false });
    } else if (before && !after) {
      deleted.push({ name, kind: "scalar_type", before: before as unknown as TransientValue, after: null, cascaded: false });
    }
  }

  // extends-cascade: every schema (in the ORIGINAL/snapshot model) that
  // transitively `extends` a name in changedOrDeletedSchemaNames is
  // "considered as deleted" too, per document_part-definition-model_upgrade.md,
  // unless it was itself already directly changed/deleted above.
  const childrenOf = new Map<string, string[]>();
  for (const s of Object.values(snapshot.schemas)) {
    if (!s.extends) continue;
    const list = childrenOf.get(s.extends) ?? [];
    list.push(s.name);
    childrenOf.set(s.extends, list);
  }
  const cascadeDeleted: ModelDiffEntry[] = [];
  const seen = new Set<string>(changedOrDeletedSchemaNames);
  const queue = [...changedOrDeletedSchemaNames];
  while (queue.length > 0) {
    const parent = queue.shift() as string;
    for (const childName of childrenOf.get(parent) ?? []) {
      if (seen.has(childName)) continue;
      seen.add(childName);
      queue.push(childName);
      const before = snapshot.schemas[childName];
      if (before) {
        cascadeDeleted.push({ name: childName, kind: "schema", before: before as unknown as TransientValue, after: null, cascaded: true });
      }
    }
  }

  return { changed, deleted, cascadeDeleted };
}
