import { BASE_SCALAR_TYPES, BUILTIN_SCALAR_TYPES, META_SCHEMAS, baseScalarDefault, baseScalarNull, isBaseScalarType } from "./builtins.js";
import { validateUiAccessConstraints } from "./uiAccess.js";
import { parseMapType } from "./mapTypes.js";
import { modelError } from "./errors.js";
import { validateExtensionSchema } from "./extensions.js";
import { validateFacetSchema } from "./facets.js";
import type {
  NormalizedProperty,
  NormalizedScalarType,
  NormalizedSchema,
  TransientObject,
  TransientValue,
} from "./types.js";

/**
 * Turning an authored (sugared) schema / property / scalar_type description into
 * its normalized form, per packages/core/docs/spec/model-command-language.md#schema-processing.
 *
 * Because a schema's `extends` target must already exist (and already be
 * normalized) before it can be named, `properties` and `constraints` are fully
 * flattened once, here, at add/update time — every NormalizedSchema handed
 * around after this point already has its complete, resolved property list.
 * Nothing downstream needs to walk an extends chain again.
 */

const SCHEMA_META_PROPS = new Set(["name", "description", "content", "extends", "cannot_be_extended", "properties", "constraints"]);
const PROPERTY_META_PROPS = new Set(["name", "type", "default_value", "null_value", "constraints"]);
const SCALAR_TYPE_META_PROPS = new Set(["name", "extends", "constraints"]);

function asObject(value: TransientValue, what: string): TransientObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw modelError("constraint_violation", `${what} must be an object`);
  }
  return value as TransientObject;
}

function collectConstraints(
  raw: TransientObject,
  declared: Set<string>,
  base: Record<string, TransientValue> = {},
): Record<string, TransientValue> {
  const constraints: Record<string, TransientValue> = { ...base };
  for (const [key, value] of Object.entries(raw)) {
    if (declared.has(key)) continue;
    constraints[key] = value === null || value === undefined ? true : value;
  }
  // an explicitly-authored `constraints:` object is just more constraint entries
  if (raw.constraints && typeof raw.constraints === "object" && !Array.isArray(raw.constraints)) {
    Object.assign(constraints, raw.constraints as Record<string, TransientValue>);
  } else if (Array.isArray(raw.constraints)) {
    for (const entry of raw.constraints) {
      if (entry && typeof entry === "object" && !Array.isArray(entry) && "name" in entry) {
        const e = entry as TransientObject;
        constraints[String(e.name)] = "value" in e ? (e as TransientObject).value : true;
      }
    }
  }
  return constraints;
}

function parseTypeSugar(type: string): { type: string; isArray: boolean } {
  const trimmed = type.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return { type: trimmed.slice(1, -1).trim(), isArray: true };
  }
  return { type: trimmed, isArray: false };
}

/**
 * `inherited` is the same-named property this one overrides, when the schema
 * being processed `extends` one that already declares it (see
 * processSchemaDescription below). An override refines: whatever it states
 * wins, and everything it leaves out — `type`, the two value fields, every
 * constraint — carries through from `inherited`. That makes `type` optional
 * on an override, and only there; a property with nothing to inherit from
 * still has to declare one.
 */
/**
 * `default_value`/`null_value` are stored as `string | null` (raw, unresolved
 * — see types.ts): whatever scalar the author writes is coerced back to its
 * property's real type later, by `coerceScalar`, at instance-construction
 * time. So a boolean or integer literal here (`default_value: true`,
 * `default_value: 10`) is exactly as authored as a string one — only the
 * shape stored differs — and stringifying it is not a narrowing, just
 * matching the storage contract. Anything else (an array, an object) has no
 * sensible string form and is rejected. (A `typeof x ===
 * "string"` check would treat an authored non-string default/null as absent,
 * silently falling back to the inherited value or to null instead of storing
 * the author's override.)
 */
function normalizeValueField(propName: string, field: "default_value" | "null_value", value: TransientValue): string | null {
  if (value === null) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  throw modelError("constraint_violation", `property "${propName}"'s \`${field}\` must be a string, number, boolean, or null`);
}

/**
 * Normalizes an authored property: the `[type]` sugar becomes `is_array`, and
 * every key the meta-model does not declare becomes a constraint. `inherited`
 * is the property of the same name on the parent schema: its type, default
 * value, null value and constraints carry over unless restated, and a
 * different `type` throws `property_type_change`.
 */
export function processPropertyDescription(raw: TransientValue, inherited?: NormalizedProperty): NormalizedProperty {
  const obj = asObject(raw, "a property description");
  if (typeof obj.name !== "string" || !obj.name) {
    throw modelError("constraint_violation", "a property description requires a string `name`");
  }
  const declaresType = obj.type !== undefined && obj.type !== null;
  if (declaresType ? typeof obj.type !== "string" || !obj.type : !inherited) {
    throw modelError("constraint_violation", `property "${obj.name}" requires a string \`type\``);
  }
  const { type, isArray } = declaresType ? parseTypeSugar(obj.type as string) : { type: (inherited as NormalizedProperty).type, isArray: false };
  if (inherited && type !== inherited.type) {
    throw modelError(
      "property_type_change",
      `property "${obj.name}" overrides an inherited property but retypes it from "${inherited.type}" to "${type}"`,
    );
  }
  const constraints = collectConstraints(obj, PROPERTY_META_PROPS);
  if (isArray) constraints.is_array = true;
  // a set and a unique array are arrays: the processed property carries both, so `min_length`, `max_length` and every reader of `is_array` apply unchanged
  if (constraints.is_set === true || constraints.is_unique === true) constraints.is_array = true;
  // an extension relation is mandatory and owner: the extended instance owns its extension instance
  if (constraints.extension === true) {
    constraints.mandatory = true;
    constraints.owner = true;
  }
  return {
    name: obj.name,
    type,
    default_value: "default_value" in obj ? normalizeValueField(obj.name, "default_value", obj.default_value) : (inherited?.default_value ?? null),
    null_value: "null_value" in obj ? normalizeValueField(obj.name, "null_value", obj.null_value) : (inherited?.null_value ?? null),
    constraints: inherited ? { ...inherited.constraints, ...constraints } : constraints,
  };
}

function checkExtendsCycle(
  childName: string,
  parent: NormalizedSchema | NormalizedScalarType,
  resolve: (name: string) => NormalizedSchema | NormalizedScalarType | undefined,
) {
  let current: string | null = parent.extends;
  while (current) {
    if (current === childName) {
      throw modelError("extends_cycle", `"${childName}" extends itself through "${parent.name}"`);
    }
    const next = resolve(current);
    current = next ? next.extends : null;
  }
}

/**
 * Normalizes an authored schema. The schema named by `extends` must exist and
 * is flattened in: the result holds the complete property list and the merged
 * constraints, so nothing downstream walks the `extends` chain. An own property
 * named like an inherited one refines it. Throws `unknown_extends_target`,
 * `extends_cycle`, `duplicate_property_name`, `property_type_change`, and
 * `constraint_violation` for a malformed description or a constraint that does
 * not hold.
 */
export function processSchemaDescription(raw: TransientValue, ctx: TypeResolutionContext): NormalizedSchema {
  const obj = asObject(raw, "a schema description");
  if (typeof obj.name !== "string" || !obj.name) {
    throw modelError("constraint_violation", "a schema description requires a string `name`");
  }

  const ownConstraints = collectConstraints(obj, SCHEMA_META_PROPS);
  const extendsName = typeof obj.extends === "string" ? obj.extends : null;

  // The parent resolves before this schema's own properties are processed:
  // an own property naming one the parent already declares is an override,
  // and processPropertyDescription needs the inherited property to refine.
  let parent: NormalizedSchema | undefined;
  if (extendsName) {
    parent = ctx.resolveSchema(extendsName);
    if (!parent) {
      throw modelError("unknown_extends_target", `schema "${obj.name}" extends unknown schema "${extendsName}"`);
    }
    checkExtendsCycle(obj.name, parent, ctx.resolveSchema);
    if (parent.properties.some((p) => p.constraints.extension === true)) {
      throw modelError("constraint_violation", `schema "${obj.name}" extends "${parent.name}", an extension schema — an extension schema cannot be extended`);
    }
  }
  const inherited = new Map<string, NormalizedProperty>((parent?.properties ?? []).map((p) => [p.name, p] as const));

  const ownPropertiesRaw = Array.isArray(obj.properties) ? obj.properties : [];
  const seen = new Set<string>();
  const ownProperties = ownPropertiesRaw.map((p) => {
    const declaredName = p !== null && typeof p === "object" && !Array.isArray(p) ? (p as TransientObject).name : undefined;
    const overridden = typeof declaredName === "string" ? inherited.get(declaredName) : undefined;
    if (typeof overridden?.constraints.__extension === "string") {
      throw modelError(
        "constraint_violation",
        `schema "${obj.name}" declares "${overridden.name}", a property of the extension "${overridden.constraints.__extension}" of its parent "${parent?.name}"`,
      );
    }
    const normalized = processPropertyDescription(p, overridden);
    if (seen.has(normalized.name)) {
      throw modelError("duplicate_property_name", `schema "${obj.name}" declares "${normalized.name}" twice`);
    }
    seen.add(normalized.name);
    return normalized;
  });

  let properties = ownProperties;
  let constraints = ownConstraints;

  if (parent) {
    const merged = new Map<string, NormalizedProperty>();
    for (const p of parent.properties) merged.set(p.name, p);
    for (const p of ownProperties) merged.set(p.name, p);
    properties = [...merged.values()];
    constraints = { ...parent.constraints, ...ownConstraints };
    // each schema states these for itself: `crud` belongs to its module, and the child of an abstract schema has instances
    for (const own of ["crud", "abstract"]) if (!(own in ownConstraints)) delete constraints[own];
  }

  // Inherited properties count toward "at most one per role" too — a subclass
  // can't add a second is_content/is_folder property just because its own
  // ownProperties list doesn't mention the parent's.
  validatePropertyRoles(obj.name, properties, ctx);
  validateSetProperties(obj.name, properties, ctx);
  validateUniqueProperties(obj.name, properties, ctx);
  validateRelationsAreSingleValued(obj.name, properties, ctx);
  validateMapProperties(obj.name, properties, ctx);
  validateObservableConstraint(obj.name, constraints);
  validateObservablePropertyConstraints(obj.name, properties, constraints, ctx);
  validateOnDeleteConstraints(obj.name, properties, ctx);
  validateUiAccessConstraints(obj.name, properties, constraints);
  validateExtensionSchema(obj.name, properties, constraints, ctx);
  validateFacetSchema(obj.name, properties, constraints, parent, ctx);

  return {
    name: obj.name,
    description: typeof obj.description === "string" ? obj.description : "",
    // Own, never merged from `parent` — a schema's content describes that
    // schema, the same as its description.
    content: typeof obj.content === "string" ? obj.content : "",
    extends: extendsName,
    cannot_be_extended: obj.cannot_be_extended === true,
    properties,
    constraints,
  };
}

/**
 * Normalizes an authored scalar type: its constraints are those of the scalar
 * type it extends, found through `resolveScalarType`, overlaid by its own; a
 * base scalar type contributes none. Throws `unknown_extends_target` for an
 * unknown parent and `extends_cycle` for a cycle.
 */
export function processScalarTypeDescription(
  raw: TransientValue,
  resolveScalarType: (name: string) => NormalizedScalarType | undefined,
): NormalizedScalarType {
  const obj = asObject(raw, "a scalar_type description");
  if (typeof obj.name !== "string" || !obj.name) {
    throw modelError("constraint_violation", "a scalar_type description requires a string `name`");
  }
  const ownConstraints = collectConstraints(obj, SCALAR_TYPE_META_PROPS);
  const extendsName = typeof obj.extends === "string" ? obj.extends : null;

  let constraints = ownConstraints;
  if (extendsName && !isBaseScalarType(extendsName)) {
    const parent = resolveScalarType(extendsName);
    if (!parent) {
      throw modelError("unknown_extends_target", `scalar_type "${obj.name}" extends unknown scalar type "${extendsName}"`);
    }
    checkExtendsCycle(obj.name, parent, resolveScalarType);
    constraints = { ...parent.constraints, ...ownConstraints };
  }

  return { name: obj.name, extends: extendsName, constraints };
}

// ---------------------------------------------------------------------------
// Property type resolution — is a property's `type` a scalar or a relation?
// ---------------------------------------------------------------------------

/** A scalar type resolved to its base scalar type and its merged constraints. */
export interface ResolvedScalar {
  kind: "scalar";
  base: (typeof BASE_SCALAR_TYPES)[number];
  constraints: Record<string, TransientValue>;
}

export type ResolvedType =
  | ResolvedScalar
  | { kind: "map"; key: ResolvedScalar; value: ResolvedScalar }
  | { kind: "relation"; schema: NormalizedSchema };

export interface TypeResolutionContext {
  resolveSchema(name: string): NormalizedSchema | undefined;
  resolveScalarType(name: string): NormalizedScalarType | undefined;
  /**
   * Whether `resolveType` falls back on `BUILTIN_SCALAR_TYPES` for a name the
   * context does not resolve. `true` when absent. A module set (modules.ts)
   * sets it to `false`: it resolves the standard types of `mcl:core` itself, and
   * a definition of a module that shadows one of them must win.
   */
  builtinScalarTypes?: boolean;
}

/**
 * Resolves a property `type` to a map of two scalar types when it is a map type
 * (`{K: V}`, `localized_string`, `localized_markdown`, see `mapTypes.ts`), else to a
 * base scalar type with its merged
 * constraints, or to a relation target. A scalar type declared by the dataset
 * or by its format's built-in overlay (`ctx.resolveScalarType`) takes
 * precedence over the placeholder of `BUILTIN_SCALAR_TYPES`, which serves only
 * when none is declared: the pattern of the format's `identifier` governs, not
 * the placeholder's empty pattern. A context that sets `builtinScalarTypes` to
 * `false` gets no placeholder at all. A name that is neither a scalar type nor
 * a schema throws `unknown_scalar_type`.
 */
export function resolveType(typeName: string, ctx: TypeResolutionContext): ResolvedType {
  const mapParts = parseMapType(typeName);
  if (mapParts) {
    const key = resolveType(mapParts.key, ctx);
    const value = resolveType(mapParts.value, ctx);
    if (key.kind !== "scalar" || key.base !== "string") {
      throw modelError("constraint_violation", `the key type "${mapParts.key}" of map type "${typeName}" must be a string-based scalar type`);
    }
    if (value.kind !== "scalar") {
      throw modelError("constraint_violation", `the value type "${mapParts.value}" of map type "${typeName}" must be a scalar type`);
    }
    return { kind: "map", key, value };
  }
  if (isBaseScalarType(typeName)) {
    return { kind: "scalar", base: typeName, constraints: {} };
  }
  const builtins = ctx.builtinScalarTypes !== false;
  const builtin = builtins ? BUILTIN_SCALAR_TYPES[typeName] : undefined;
  const scalarType = ctx.resolveScalarType(typeName) ?? builtin;
  if (scalarType) {
    // walk the extends chain to the base, merging constraints child-over-parent
    let constraints: Record<string, TransientValue> = {};
    let current: NormalizedScalarType | undefined = scalarType;
    const chain: NormalizedScalarType[] = [];
    while (current) {
      chain.unshift(current);
      if (!current.extends) break;
      if (isBaseScalarType(current.extends)) {
        for (const st of chain) constraints = { ...constraints, ...st.constraints };
        return { kind: "scalar", base: current.extends, constraints };
      }
      current = (builtins ? BUILTIN_SCALAR_TYPES[current.extends] : undefined) ?? ctx.resolveScalarType(current.extends);
    }
    for (const st of chain) constraints = { ...constraints, ...st.constraints };
    // reached the end without hitting a base type name explicitly (shouldn't
    // happen for well-formed data, but fall back to string rather than crash)
    return { kind: "scalar", base: "string", constraints };
  }
  const schema = ctx.resolveSchema(typeName);
  if (schema) {
    return { kind: "relation", schema };
  }
  throw modelError("unknown_scalar_type", `"${typeName}" is neither a known scalar type nor a schema`);
}

export function scalarDefaultValue(resolved: Extract<ResolvedType, { kind: "scalar" }>): TransientValue {
  return baseScalarDefault(resolved.base);
}

export function scalarNullValue(resolved: Extract<ResolvedType, { kind: "scalar" }>): TransientValue {
  return baseScalarNull(resolved.base);
}

// ---------------------------------------------------------------------------
// Property roles — is_content/is_folder, per packages/core/docs/spec/meta-model.md#property-constraints's
// "Property roles" and
// the `getInstance` doc comment of `PersistenceInterface`. Neither changes what's valid
// data; each just marks which (at most one) property a persistent format may
// treat specially. Validated here, at Schema Processing time, rather than
// left to whichever format first tries to interpret a bad schema.
// ---------------------------------------------------------------------------

/** Property constraint name -> the role name it marks, per the two docs above. */
const ROLE_CONSTRAINTS: Record<string, string> = {
  is_content: "content",
  is_folder: "folder",
};

/**
 * At most one property per schema may carry each role constraint, and each
 * role has its own type requirement: `is_content`'s property must resolve to
 * `markdown` (the base builtin scalar type, or anything extending it — see
 * resolveType's constraint-merging); `is_folder`'s must resolve to any
 * string-based scalar type. Neither is meaningful on an array property (a
 * single instance has one body, one folder path), so `is_array` is rejected
 * outright rather than silently taking, say, the first element.
 */
function validatePropertyRoles(schemaName: string, properties: NormalizedProperty[], ctx: TypeResolutionContext): void {
  for (const [constraintName, role] of Object.entries(ROLE_CONSTRAINTS)) {
    const carriers = properties.filter((p) => p.constraints[constraintName] === true);
    if (carriers.length > 1) {
      throw modelError(
        "constraint_violation",
        `schema "${schemaName}" has more than one "${constraintName}" property (${carriers.map((p) => p.name).join(", ")}) — at most one is allowed`,
      );
    }
    if (carriers.length === 0) continue;
    const prop = carriers[0];
    if (prop.constraints.is_array === true) {
      throw modelError("constraint_violation", `"${prop.name}" on schema "${schemaName}" carries "${constraintName}" but is an array — a single instance has only one ${role}`);
    }
    const resolved = resolveType(prop.type, ctx);
    if (role === "content") {
      const ok = resolved.kind === "scalar" && resolved.base === "string" && resolved.constraints.markdown === true;
      if (!ok) {
        throw modelError(
          "constraint_violation",
          `"${prop.name}" on schema "${schemaName}" has "is_content" but its type ("${prop.type}") does not resolve to "markdown"`,
        );
      }
    } else if (role === "folder") {
      const ok = resolved.kind === "scalar" && resolved.base === "string";
      if (!ok) {
        throw modelError(
          "constraint_violation",
          `"${prop.name}" on schema "${schemaName}" has "is_folder" but its type ("${prop.type}") does not resolve to a string-based scalar type`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Relations are single-valued when directly declared — `relations` part:
// "A directly declared
// relation is always single-valued: is_array cannot be set on a relation
// property ... A relation reaching several instances only exists as a
// virtual relation, generated on the target schema from inverse_is_array ...
// In consequence a many-to-many relationship cannot be declared directly: it
// must be reified as its own schema, holding a direct relation to each
// side." Only a property whose type resolves to a relation is rejected here
// — is_array on a scalar-typed property is unaffected, per
// property_constraints.md.
//
// A property carrying "__generated" IS that virtual relation — materialized
// by applyInverseRelations (modelUpgrade.ts), never authored directly — so
// it's exempt rather than rejected: it's exactly the is_array relation the
// quoted rule above allows, not a directly declared one. Without this
// exemption, extends resolution's own property merge (a few lines up, in
// processSchemaDescription) carries a parent's already-generated relation
// into every extending child, and the child's very next processing pass
// trips this check on a property it never authored at all.
// ---------------------------------------------------------------------------

function validateRelationsAreSingleValued(schemaName: string, properties: NormalizedProperty[], ctx: TypeResolutionContext): void {
  for (const prop of properties) {
    if (prop.constraints.is_array !== true) continue;
    if (prop.constraints.__generated === true) continue;
    const resolved = resolveType(prop.type, ctx);
    if (resolved.kind === "relation") {
      throw modelError(
        "constraint_violation",
        `"${prop.name}" on schema "${schemaName}" is a relation but has "is_array" — a directly declared relation is always single-valued`,
      );
    }
  }
}

/**
 * Validates the `observable` schema constraint: incompatible with
 * `embedded` — an embedded instance has no key, so it can't be named in a
 * `(schema, key)` delta entry.
 */
function validateObservableConstraint(schemaName: string, constraints: Record<string, TransientValue>): void {
  if (constraints.observable === true && constraints.embedded === true) {
    throw modelError(
      "constraint_violation",
      `schema "${schemaName}" has both "observable" and "embedded" — an embedded instance has no key and cannot be tracked in observable deltas`,
    );
  }
}

/**
 * Validates property-level `observable` constraints: valid only on a
 * relation property, and only when the owning schema itself carries the
 * schema-level `observable` constraint.
 */
function validateObservablePropertyConstraints(
  schemaName: string,
  properties: NormalizedProperty[],
  schemaConstraints: Record<string, TransientValue>,
  ctx: TypeResolutionContext,
): void {
  const schemaIsObservable = schemaConstraints.observable === true;
  
  for (const prop of properties) {
    if (prop.constraints.observable !== true) continue;
    
    // Property-level observable requires schema-level observable
    if (!schemaIsObservable) {
      throw modelError(
        "constraint_violation",
        `property "${prop.name}" on schema "${schemaName}" has "observable" but the schema itself is not observable — property-level observable requires schema-level observable`,
      );
    }
    
    // Property-level observable is only valid on relations
    const resolved = resolveType(prop.type, ctx);
    if (resolved.kind !== "relation") {
      throw modelError(
        "constraint_violation",
        `property "${prop.name}" on schema "${schemaName}" has "observable" but is not a relation — property-level observable is only valid on relation properties`,
      );
    }
  }
}

/**
 * The schema's `propertyRoles` — `Record<role, propertyName>` — handed to
 * `PersistenceInterface`'s `getInstance`/`listInstances`/`putInstance` per
 * the doc comment of `getInstance`. Assumes `schema` already
 * passed `validatePropertyRoles` (true for anything that went through
 * `processSchemaDescription`), so no re-validation here — just extraction.
 * Deliberately not memoized: `schema.properties` is already resolved,
 * in-memory data by the time anything calls this (Schema Processing has
 * already flattened `extends`), so this is a handful of property-array scans,
 * not an I/O cost worth caching against.
 */
export function derivePropertyRoles(schema: NormalizedSchema): Record<string, string> {
  const roles: Record<string, string> = {};
  for (const prop of schema.properties) {
    for (const [constraintName, role] of Object.entries(ROLE_CONSTRAINTS)) {
      if (prop.constraints[constraintName] === true) roles[role] = prop.name;
    }
  }
  return roles;
}

/**
 * Shared empty-roles constant for every call site that operates on
 * `scalar_type`/`import` themselves (or the internal upgrade-locator
 * schemas) — none of those carries a role, per both docs' "Property
 * roles" sections. Frozen so nothing downstream can mutate a shared instance.
 */
export const NO_ROLES: Record<string, string> = Object.freeze({});

/**
 * The `schema` meta-schema's own roles — its `content` property carries
 * `is_content` (packages/core/docs/spec/meta-model.md#schema), so a `schema` instance
 * reaches storage with a content role the same way any other instance does,
 * and every call site reading or writing one passes this rather than
 * `NO_ROLES`. Derived once from `META_SCHEMAS`, which is fixed at build time.
 */
export const SCHEMA_ROLES: Record<string, string> = Object.freeze(derivePropertyRoles(META_SCHEMAS.schema));

/** The values of the `on_delete` relation constraint. */
export const ON_DELETE_VALUES = ["restrict", "cascade", "set_null"] as const;

/** What the deletion of the target of a relation does to the declaring instance. */
export type OnDelete = (typeof ON_DELETE_VALUES)[number];

/**
 * `on_delete` says what the deletion of the target of a relation does to the
 * instance declaring it: `restrict`, `cascade` or `set_null`. It is valid on a
 * relation only, never on an `owner` or `extension` relation (the owner already
 * removes the instance with it), and `set_null` is refused on a `mandatory`
 * relation, which cannot be null. Each breach is a `constraint_violation`.
 */
function validateOnDeleteConstraints(schemaName: string, properties: NormalizedProperty[], ctx: TypeResolutionContext): void {
  for (const prop of properties) {
    const value = prop.constraints.on_delete;
    if (value === undefined || prop.constraints.__generated === true) continue;
    if (typeof value !== "string" || !(ON_DELETE_VALUES as readonly string[]).includes(value)) {
      throw modelError(
        "constraint_violation",
        `"${prop.name}" on schema "${schemaName}" has an "on_delete" that is not one of ${ON_DELETE_VALUES.join(", ")}`,
      );
    }
    if (resolveType(prop.type, ctx).kind !== "relation") {
      throw modelError("constraint_violation", `"${prop.name}" on schema "${schemaName}" has "on_delete" but is not a relation`);
    }
    if (prop.constraints.owner === true || prop.constraints.extension === true) {
      throw modelError(
        "constraint_violation",
        `"${prop.name}" on schema "${schemaName}" has "on_delete" but is an owner or extension relation — its owner already removes the instance with it`,
      );
    }
    if (value === "set_null" && prop.constraints.mandatory === true) {
      throw modelError("constraint_violation", `"${prop.name}" on schema "${schemaName}" is "mandatory" and cannot be "on_delete: set_null"`);
    }
  }
}

/**
 * `is_set` marks a property holding distinct values in no meaningful order. It
 * needs a scalar property whose constraints include `enum`, from its scalar type
 * or from the property itself: the enum gives the admissible values and their
 * canonical order. A relation, a map and a property without `enum` are refused
 * with `constraint_violation`. `is_array` is implied, see
 * `processPropertyDescription`.
 */
function validateSetProperties(schemaName: string, properties: NormalizedProperty[], ctx: TypeResolutionContext): void {
  for (const prop of properties) {
    if (prop.constraints.is_set !== true || prop.constraints.__generated === true) continue;
    const resolved = resolveType(prop.type, ctx);
    if (resolved.kind !== "scalar") {
      throw modelError(
        "constraint_violation",
        `"${prop.name}" on schema "${schemaName}" has "is_set" but is a ${resolved.kind} — a set holds values of an enum scalar type`,
      );
    }
    if (!Array.isArray({ ...resolved.constraints, ...prop.constraints }.enum)) {
      throw modelError(
        "constraint_violation",
        `"${prop.name}" on schema "${schemaName}" has "is_set" but its type ("${prop.type}") has no "enum" — a set holds values of an enum scalar type`,
      );
    }
  }
}

/**
 * `is_unique` marks an array property whose entries are distinct, in the order
 * given. It needs a scalar property of any type, with no `enum`: a relation and
 * a map are refused with `constraint_violation`. `is_array` is implied, see
 * `processPropertyDescription`.
 */
function validateUniqueProperties(schemaName: string, properties: NormalizedProperty[], ctx: TypeResolutionContext): void {
  for (const prop of properties) {
    if (prop.constraints.is_unique !== true || prop.constraints.__generated === true) continue;
    const resolved = resolveType(prop.type, ctx);
    if (resolved.kind !== "scalar") {
      throw modelError(
        "constraint_violation",
        `"${prop.name}" on schema "${schemaName}" has "is_unique" but is a ${resolved.kind} — a unique array holds scalar values`,
      );
    }
  }
}

/**
 * A property of a map type (see `mapTypes.ts`) resolves its key and value
 * types, which must be a string-based and a scalar type, and takes neither
 * `is_array`, `default_value` nor `null_value`: a map is single-valued and
 * its default and null value are always `{}`. `is_content` and `is_folder`
 * are refused by `validatePropertyRoles`, which accepts only a scalar.
 */
function validateMapProperties(schemaName: string, properties: NormalizedProperty[], ctx: TypeResolutionContext): void {
  for (const prop of properties) {
    if (parseMapType(prop.type) === null) continue;
    resolveType(prop.type, ctx);
    if (prop.constraints.is_array === true) {
      throw modelError("constraint_violation", `"${prop.name}" on schema "${schemaName}" is a map but has "is_array" — a map is single-valued`);
    }
    if (prop.default_value !== null || prop.null_value !== null) {
      throw modelError(
        "constraint_violation",
        `"${prop.name}" on schema "${schemaName}" is a map and takes neither "default_value" nor "null_value" — its default and null value are {}`,
      );
    }
  }
}
