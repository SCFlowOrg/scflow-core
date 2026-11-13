import * as YAML from "js-yaml";
import { isBaseScalarType } from "./builtins.js";
import { coerceScalar, validateScalarValue } from "./command.js";
import { modelError } from "./errors.js";
import { parseMapType, LOCALIZED_MAP_TYPES } from "./mapTypes.js";
import { MCL_CORE, MCL_CORE_KEY, MCL_NAMESPACE } from "./mclCore.js";
import type { ModuleDependency, ModuleManifest, ModuleSkill, ModuleTopic } from "./mclCore.js";
import { generatedActionIds } from "./moduleActions.js";
import {
  processScalarTypeDescription,
  processSchemaDescription,
  resolveType,
  scalarDefaultValue,
  scalarNullValue,
} from "./schemaProcessing.js";
import type { TypeResolutionContext } from "./schemaProcessing.js";
import { isPlainObject } from "./textOperations.js";
import type {
  NormalizedScalarType,
  NormalizedSchema,
  TransientObject,
  TransientValue,
} from "./types.js";

/**
 * Modules and names, per packages/core/docs/spec/meta-model.md#module,
 * #names and #the-core-module.
 *
 * A module owns its schemas, scalar types, actions and skills. `readModuleManifest`
 * reads a `module.yaml` and validates it as an instance of the `module` schema
 * of `mcl:core`. `createModuleSet` puts modules together, always with
 * `mcl:core`, refuses two modules with one namespace, and processes the schemas
 * and scalar types of each module with the names resolved from where they are
 * written. A module set stands apart from any dataset: a dataset uses one when
 * it lists its modules.
 */

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

const CORE_SCHEMAS = new Map<string, NormalizedSchema>(
  MCL_CORE.schemas.map((s) => [s.name, s] as const),
);
const CORE_SCALAR_TYPES = new Map<string, NormalizedScalarType>(
  MCL_CORE.scalar_types.map((t) => [t.name, t] as const),
);

/** Resolves the names of `mcl:core` alone: the context a manifest is validated in. */
const CORE_CONTEXT: TypeResolutionContext = {
  resolveSchema: (name) => CORE_SCHEMAS.get(name),
  resolveScalarType: (name) => CORE_SCALAR_TYPES.get(name),
  builtinScalarTypes: false,
};

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

/**
 * Validates `raw` against the schema `schemaName` of `mcl:core` and returns it
 * with every scalar property set: a missing value takes its default, a null
 * one its null value, as a command would store them. A key the schema does not
 * declare, a value of the wrong shape or one that breaks a constraint throws
 * `constraint_violation`. An embedded relation is validated entry by entry; the
 * properties in `passed` are kept as given, for the caller to check.
 */
function validateCoreInstance(
  schemaName: string,
  raw: unknown,
  where: string,
  passed: ReadonlySet<string> = new Set(),
): TransientObject {
  const schema = CORE_SCHEMAS.get(schemaName) as NormalizedSchema;
  if (!isPlainObject(raw))
    throw modelError(
      "constraint_violation",
      `${where} must be a mapping, as an instance of "${schemaName}"`,
    );
  const declared = new Set(schema.properties.map((p) => p.name));
  const unknown = Object.keys(raw).filter((k) => !declared.has(k));
  if (unknown.length > 0) {
    throw modelError(
      "constraint_violation",
      `${where} has ${unknown.map((k) => `"${k}"`).join(", ")}, which "${schemaName}" does not declare`,
    );
  }
  const out: TransientObject = {};
  for (const prop of schema.properties) {
    const value = raw[prop.name];
    const path = `${where}.${prop.name}`;
    const isArray = prop.constraints.is_array === true;
    if (passed.has(prop.name)) {
      if (value === undefined || value === null) out[prop.name] = isArray ? [] : null;
      else if (isArray && !Array.isArray(value))
        throw modelError("constraint_violation", `${path} must be a list`);
      else out[prop.name] = value;
      continue;
    }
    const resolved = resolveType(prop.type, CORE_CONTEXT);
    if (resolved.kind === "relation") {
      // only an embedded schema is validated in place; the module schema owns the others, which the caller checks
      if (value === undefined || value === null) {
        out[prop.name] = isArray ? [] : null;
      } else if (isArray) {
        if (!Array.isArray(value))
          throw modelError("constraint_violation", `${path} must be a list`);
        out[prop.name] = value.map((entry, i) =>
          validateCoreInstance(resolved.schema.name, entry, `${path}[${i}]`),
        );
      } else {
        out[prop.name] = validateCoreInstance(resolved.schema.name, value, path);
      }
      continue;
    }
    if (resolved.kind === "map")
      throw modelError("constraint_violation", `${path}: a map is not part of a manifest`);
    const eff = { ...resolved.constraints, ...prop.constraints };
    const scalar = (v: TransientValue | undefined, at: string): TransientValue => {
      if (v === undefined) return prop.default_value ?? scalarDefaultValue(resolved);
      if (v === null) return scalarNullValue(resolved);
      if (typeof v === "object")
        throw modelError("constraint_violation", `${at} must be a ${resolved.base}`);
      return coerceScalar(v, resolved.base);
    };
    if (isArray) {
      if (value !== undefined && value !== null && !Array.isArray(value))
        throw modelError("constraint_violation", `${path} must be a list`);
      const values = (Array.isArray(value) ? value : []).map((v, i) => scalar(v, `${path}[${i}]`));
      for (const v of values) validateScalarValue(path, resolved.base, v, eff);
      out[prop.name] = values;
    } else {
      const v = scalar(value as TransientValue | undefined, path);
      validateScalarValue(path, resolved.base, v, eff);
      out[prop.name] = v;
    }
  }
  return out;
}

/**
 * Whether `file` is a path a skill may name: relative, inside the package of
 * its module, with `/` between its parts and the extension `.md`. A URL, an
 * absolute path, a drive, a part `.` or `..` and a `\` are refused (see Skill
 * in `docs/spec/meta-model.md`).
 */
export function isSkillFile(file: string): boolean {
  if (!file.endsWith(".md") || file.includes("\\") || file.includes(":") || file.startsWith("/")) return false;
  return file.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

/** The list of mappings a manifest gives for `what`, or `[]` when it gives none. */
function listOfMappings(
  value: TransientValue,
  what: string,
): Array<Record<string, TransientValue>> {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw modelError("constraint_violation", `${what} must be a list`);
  return value.map((entry, i) => {
    if (!isPlainObject(entry))
      throw modelError("constraint_violation", `${what}[${i}] must be a mapping`);
    return entry;
  });
}

/**
 * Validates a module manifest, already parsed, as an instance of the `module`
 * schema of `mcl:core`, and returns it with its defaults set.
 *
 * - `name` is a `module_key`, `namespace` an `identifier`, `version` a
 *   `semantic_version` and `mcl` a `version_range`: a missing one breaks its
 *   pattern. A key `module` does not declare is refused.
 * - Each dependency is a `module_dependency`; `mcl:core`, the module itself and
 *   a module listed twice are refused.
 * - The name of each schema and scalar type is an `identifier`, never a
 *   qualified name nor a primitive of the engine (`string`, `number`,
 *   `integer`, `boolean`). A name is unique in its module, schemas and scalar
 *   types together, since a property `type` names either: a second one throws
 *   `duplicate_name`.
 * - Each action is an `action`: its `id` is the namespace of the module, a
 *   slash and an identifier, unique in the module (`duplicate_name`), and its
 *   `kind` and `exposure` take their enums. Its `parameters`, `writes` and
 *   `body` are kept as given.
 * - Each skill is a `skill`: its `id` is the namespace of the module, a slash
 *   and an identifier, unique in the module (`duplicate_name`); its `title` and
 *   `description` are given; each name of `uses` is an action id; `exposure`
 *   takes its enum; `file` is a relative `.md` path (`isSkillFile`). Whether the
 *   actions of `uses` exist is checked in a module set (`createModuleSet`), and
 *   whether the file exists where the package is read. A manifest with no skill
 *   has no `skills` entry.
 * - Each topic of `docs` is a `topic`: its `id` is the namespace of the module,
 *   a slash and a name, and an id with its locale is unique in the module
 *   (`duplicate_name`); `title` and `summary` are given; `kind`, `audience` and
 *   `locale` are checked; each name of `uses` is an action id; `file` is a
 *   relative `.md` path. A manifest with no topic has no `docs` entry.
 * - `migrations` are kept as given.
 *
 * The schemas and scalar types themselves are processed when the module joins
 * a module set (`createModuleSet`), where the names they reference resolve.
 * Every other breach throws `constraint_violation`.
 */
export function validateModuleManifest(raw: unknown): ModuleManifest {
  const owned = new Set(["schemas", "scalar_types", "actions", "skills", "docs", "migrations"]);
  const module = validateCoreInstance("module", raw, "the module", owned);
  const key = module.name as string;
  const namespace = module.namespace as string;

  const dependencies = module.dependencies as unknown as ModuleDependency[];
  const listed = new Set<string>();
  for (const dependency of dependencies) {
    if (dependency.module === MCL_CORE_KEY) {
      throw modelError(
        "constraint_violation",
        `module "${key}" lists "${MCL_CORE_KEY}" as a dependency: its range is given by \`mcl\``,
      );
    }
    if (dependency.module === key)
      throw modelError("constraint_violation", `module "${key}" depends on itself`);
    if (listed.has(dependency.module))
      throw modelError(
        "constraint_violation",
        `module "${key}" lists "${dependency.module}" twice`,
      );
    listed.add(dependency.module);
  }

  const names = new Set<string>();
  const checkName = (entry: Record<string, TransientValue>, what: string): void => {
    const name = entry.name;
    if (typeof name !== "string" || !IDENTIFIER.test(name)) {
      throw modelError(
        "constraint_violation",
        `a ${what} of module "${key}" is named ${JSON.stringify(name)}, which is not an identifier`,
      );
    }
    if (isBaseScalarType(name))
      throw modelError(
        "constraint_violation",
        `module "${key}" declares "${name}", a primitive of the engine`,
      );
    if (names.has(name))
      throw modelError("duplicate_name", `module "${key}" declares "${name}" twice`);
    names.add(name);
  };
  const scalarTypes = listOfMappings(module.scalar_types, `the scalar_types of "${key}"`);
  for (const entry of scalarTypes) checkName(entry, "scalar type");
  const schemas = listOfMappings(module.schemas, `the schemas of "${key}"`);
  for (const entry of schemas) checkName(entry, "schema");

  const actionId = new RegExp(`^${namespace}/[A-Za-z_][A-Za-z0-9_]*$`);
  const ids = new Set<string>();
  const actions = listOfMappings(module.actions, `the actions of "${key}"`).map((entry, i) => {
    const action = validateCoreInstance(
      "action",
      entry,
      `the action ${i} of "${key}"`,
      new Set(["parameters", "writes", "body"]),
    );
    const id = action.id as string;
    if (!actionId.test(id)) {
      throw modelError(
        "constraint_violation",
        `action "${id}" of module "${key}" must be named "${namespace}/" and an identifier`,
      );
    }
    if (ids.has(id))
      throw modelError("duplicate_name", `module "${key}" declares action "${id}" twice`);
    ids.add(id);
    return action;
  });

  const anyActionId = /^[A-Za-z_][A-Za-z0-9_]*\/[A-Za-z_][A-Za-z0-9_]*$/;
  const skillIds = new Set<string>();
  const skills = listOfMappings(module.skills, `the skills of "${key}"`).map((entry, i): ModuleSkill => {
    const skill = validateCoreInstance("skill", entry, `the skill ${i} of "${key}"`);
    const id = skill.id as string;
    const fail = (message: string): never => {
      throw modelError("constraint_violation", `skill "${id}" of module "${key}" ${message}`);
    };
    if (!actionId.test(id)) fail(`must be named "${namespace}/" and an identifier`);
    if (skillIds.has(id)) throw modelError("duplicate_name", `module "${key}" declares skill "${id}" twice`);
    skillIds.add(id);
    if ((skill.title as string).trim() === "") fail("has no title");
    if ((skill.description as string).trim() === "") fail("has no description, which says when to use it");
    const uses = skill.uses as string[];
    for (const name of uses) if (!anyActionId.test(name)) fail(`uses ${JSON.stringify(name)}, which is not an action id`);
    const file = skill.file as string;
    if (!isSkillFile(file)) fail(`names the file ${JSON.stringify(file)}, which is not a relative path to a .md file of the package`);
    return {
      id,
      title: skill.title as string,
      description: skill.description as string,
      uses: [...uses],
      exposure: skill.exposure as ModuleSkill["exposure"],
      file,
    };
  });

  const topicKeys = new Set<string>();
  const topicName = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/;
  const language = /^[a-z]{2,3}(-[A-Za-z0-9]+)*$/;
  const docs = listOfMappings(module.docs, `the docs of "${key}"`).map((entry, i): ModuleTopic => {
    const topic = validateCoreInstance("topic", entry, `the topic ${i} of "${key}"`);
    const id = topic.id as string;
    const fail = (message: string): never => {
      throw modelError("constraint_violation", `topic "${id}" of module "${key}" ${message}`);
    };
    if (!id.startsWith(`${namespace}/`) || !topicName.test(id.slice(namespace.length + 1)))
      fail(`must be named "${namespace}/" and a name of letters, digits, "_", "-" and "."`);
    const locale = topic.locale as string;
    if (!language.test(locale)) fail(`has the locale ${JSON.stringify(locale)}, which is not a language tag such as "en"`);
    const topicKey = `${id}|${locale}`;
    if (topicKeys.has(topicKey)) throw modelError("duplicate_name", `module "${key}" declares topic "${id}" in "${locale}" twice`);
    topicKeys.add(topicKey);
    if ((topic.title as string).trim() === "") fail("has no title");
    if ((topic.summary as string).trim() === "") fail("has no summary");
    const uses = topic.uses as string[];
    for (const name of uses) if (!anyActionId.test(name)) fail(`uses ${JSON.stringify(name)}, which is not an action id`);
    const file = topic.file as string;
    if (!isSkillFile(file)) fail(`names the file ${JSON.stringify(file)}, which is not a relative path to a .md file of the package`);
    return {
      id,
      title: topic.title as string,
      summary: topic.summary as string,
      kind: topic.kind as ModuleTopic["kind"],
      audience: topic.audience as ModuleTopic["audience"],
      locale,
      context: [...(topic.context as string[])],
      uses: [...uses],
      generated: topic.generated === true || topic.generated === "true",
      file,
    };
  });

  const migrations = module.migrations;
  if (!Array.isArray(migrations))
    throw modelError("constraint_violation", `the migrations of "${key}" must be a list`);

  return {
    name: key,
    namespace,
    version: module.version as string,
    mcl: module.mcl as string,
    title: module.title as string,
    dependencies: dependencies.map((d) => ({ module: d.module, version: d.version })),
    schemas,
    scalar_types: scalarTypes,
    actions,
    ...(skills.length > 0 ? { skills } : {}),
    ...(docs.length > 0 ? { docs } : {}),
    migrations,
  };
}

/**
 * Reads a `module.yaml` (YAML, or JSON) without running any code, and
 * validates it with `validateModuleManifest`. A text that does not parse throws
 * `constraint_violation`.
 */
export function readModuleManifest(text: string): ModuleManifest {
  let raw: unknown;
  try {
    raw = YAML.load(text);
  } catch (error) {
    throw modelError(
      "constraint_violation",
      `the manifest does not parse: ${(error as Error).message}`,
    );
  }
  return validateModuleManifest(raw);
}

// ---------------------------------------------------------------------------
// Module set and names
// ---------------------------------------------------------------------------

/** A module of a module set, with its schemas and scalar types processed. */
export interface LoadedModule {
  /** The key of the module, `publisher:module`. */
  readonly key: string;
  readonly namespace: string;
  readonly manifest: Readonly<ModuleManifest> | typeof MCL_CORE;
  /**
   * The schemas of the module by short name. A reference they hold (a property
   * `type`, `extends`) is in its canonical form: the qualified name, or the
   * short name for `mcl:core`, so it resolves from anywhere in the set.
   */
  readonly schemas: ReadonlyMap<string, NormalizedSchema>;
  /** The scalar types of the module by short name, `extends` in its canonical form. */
  readonly scalarTypes: ReadonlyMap<string, NormalizedScalarType>;
  /** The actions of the module by id. */
  readonly actions: ReadonlyMap<string, Record<string, TransientValue>>;
}

/** A name resolved in a module set. */
export interface ResolvedName<T> {
  /** The module that owns the definition. */
  module: LoadedModule;
  /** The definition: a normalized schema or scalar type. */
  definition: T;
  /**
   * The canonical form of the name, which is its key in a dataset: the
   * qualified name, such as `scflow.actor`, or the short name for `mcl:core`.
   */
  key: string;
}

/**
 * Modules used together, always with `mcl:core`.
 *
 * A name is resolved from where it is written (`from`, the key of a module, or
 * nothing outside a module):
 * - a short name, in a module, names a definition of that module, else of
 *   `mcl:core`; outside a module, of `mcl:core` only. It is never searched for
 *   across modules.
 * - a qualified name, `namespace.name`, names a definition of the module of
 *   that namespace. In a module, it must be that module, a dependency or
 *   `mcl:core`, else `reference_outside_module` is thrown. `mcl.date` names
 *   the `date` of `mcl:core`.
 */
export interface ModuleSet {
  /** Every module of the set, `mcl:core` first. */
  readonly modules: readonly LoadedModule[];
  /** The module of key `key`, if the set holds it. */
  module(key: string): LoadedModule | undefined;
  /** The schema `name` written in module `from`, or outside a module; `undefined` when it does not resolve. */
  resolveSchema(name: string, from?: string): ResolvedName<NormalizedSchema> | undefined;
  /** The scalar type `name` written in module `from`, or outside a module; `undefined` when it does not resolve. */
  resolveScalarType(name: string, from?: string): ResolvedName<NormalizedScalarType> | undefined;
  /** As `resolveSchema`, but a name that does not resolve throws `unknown_schema`, as the `schema` of a command does. */
  requireSchema(name: string, from?: string): ResolvedName<NormalizedSchema>;
  /**
   * The context `resolveType` and schema processing take, with the names
   * resolved as written in module `from`, or outside a module. A canonical name
   * resolves in the context outside a module.
   */
  context(from?: string): TypeResolutionContext;
}

interface Entry extends LoadedModule {
  readonly dependencyKeys: ReadonlySet<string>;
  readonly authoredSchemas: Map<string, Record<string, TransientValue>>;
  readonly authoredScalarTypes: Map<string, Record<string, TransientValue>>;
  readonly schemas: Map<string, NormalizedSchema>;
  readonly scalarTypes: Map<string, NormalizedScalarType>;
  readonly inProgress: Set<string>;
}

/**
 * Puts `manifests` together with `mcl:core` and processes their schemas and
 * scalar types (see Schema Processing). Each manifest is validated first
 * (`validateModuleManifest`).
 *
 * Throws `namespace_conflict` when two modules declare the same namespace, or a
 * module declares `mcl`; `duplicate_name` when a key is given twice, or names
 * `mcl:core`; `reference_outside_module` when a schema or scalar type refers to
 * a module that is not its own, a dependency or `mcl:core`; and the exceptions
 * of schema processing, among them `unknown_scalar_type` for a property `type`
 * and `unknown_extends_target` for an `extends` that does not resolve. A
 * dependency is not required to be in the set, but its names resolve only when
 * it is; its version is not checked here.
 */
export function createModuleSet(manifests: readonly ModuleManifest[]): ModuleSet {
  const core: Entry = {
    key: MCL_CORE_KEY,
    namespace: MCL_NAMESPACE,
    manifest: MCL_CORE,
    dependencyKeys: new Set(),
    authoredSchemas: new Map(),
    authoredScalarTypes: new Map(),
    schemas: new Map(CORE_SCHEMAS),
    scalarTypes: new Map(CORE_SCALAR_TYPES),
    actions: new Map(),
    inProgress: new Set(),
  };
  const byKey = new Map<string, Entry>([[core.key, core]]);
  const byNamespace = new Map<string, Entry>([[core.namespace, core]]);

  for (const given of manifests) {
    const manifest = validateModuleManifest(given);
    if (byKey.has(manifest.name))
      throw modelError("duplicate_name", `module "${manifest.name}" is given twice`);
    const clash = byNamespace.get(manifest.namespace);
    if (clash) {
      throw modelError(
        "namespace_conflict",
        `modules "${clash.key}" and "${manifest.name}" both declare the namespace "${manifest.namespace}"`,
      );
    }
    const entry: Entry = {
      key: manifest.name,
      namespace: manifest.namespace,
      manifest,
      dependencyKeys: new Set(manifest.dependencies.map((d) => d.module)),
      authoredSchemas: new Map(manifest.schemas.map((s) => [s.name as string, s] as const)),
      authoredScalarTypes: new Map(
        manifest.scalar_types.map((t) => [t.name as string, t] as const),
      ),
      schemas: new Map(),
      scalarTypes: new Map(),
      actions: new Map(manifest.actions.map((a) => [a.id as string, a] as const)),
      inProgress: new Set(),
    };
    byKey.set(entry.key, entry);
    byNamespace.set(entry.namespace, entry);
  }

  function entryOf(from: string | undefined): Entry | undefined {
    if (from === undefined) return undefined;
    const entry = byKey.get(from);
    if (!entry) throw modelError("key_not_found", `the module set holds no module "${from}"`);
    return entry;
  }

  function declares(entry: Entry, name: string): boolean {
    return (
      entry.schemas.has(name) ||
      entry.scalarTypes.has(name) ||
      entry.authoredSchemas.has(name) ||
      entry.authoredScalarTypes.has(name)
    );
  }

  /** The module and short name `name` designates as written in `from`, or `undefined` when it designates none. */
  function locate(
    name: string,
    from: Entry | undefined,
  ): { entry: Entry; short: string } | undefined {
    const dot = name.indexOf(".");
    if (dot < 0) {
      if (from && declares(from, name)) return { entry: from, short: name };
      return declares(core, name) ? { entry: core, short: name } : undefined;
    }
    const target = byNamespace.get(name.slice(0, dot));
    const short = name.slice(dot + 1);
    if (!target) return undefined;
    if (from && target !== from && target !== core && !from.dependencyKeys.has(target.key)) {
      throw modelError(
        "reference_outside_module",
        `"${name}", written in module "${from.key}", names module "${target.key}", which is not one of its dependencies`,
      );
    }
    return { entry: target, short };
  }

  function keyOf(entry: Entry, short: string): string {
    return entry === core ? short : `${entry.namespace}.${short}`;
  }

  /** The canonical form of a name written in `from`; a name that designates nothing is returned unchanged, to fail where it is used. */
  function canonical(name: string, from: Entry): string {
    if (isBaseScalarType(name)) return name;
    const located = locate(name, from);
    return located ? keyOf(located.entry, located.short) : name;
  }

  /** The canonical form of a property `type`, with its `[...]` sugar and the two names of a map type. */
  function canonicalType(type: string, from: Entry): string {
    const array = /^\[(.*)\]$/.exec(type.trim());
    if (array) return `[${canonicalType(array[1].trim(), from)}]`;
    if (LOCALIZED_MAP_TYPES.has(type)) return type;
    const map = parseMapType(type);
    if (map) return `{${canonical(map.key, from)}: ${canonical(map.value, from)}}`;
    return canonical(type, from);
  }

  function schemaOf(entry: Entry, short: string): NormalizedSchema | undefined {
    const done = entry.schemas.get(short);
    if (done) return done;
    if (!entry.authoredSchemas.has(short)) return undefined;
    // A relation back to a schema still being processed (its own, or a mutual
    // one) needs only to know that it names a schema: a stand-in serves it.
    if (entry.inProgress.has(short)) {
      return {
        name: short,
        description: "",
        content: "",
        extends: null,
        cannot_be_extended: false,
        properties: [],
        constraints: {},
      };
    }
    return processSchema(entry, short);
  }

  function scalarTypeOf(entry: Entry, short: string): NormalizedScalarType | undefined {
    const done = entry.scalarTypes.get(short);
    if (done) return done;
    if (!entry.authoredScalarTypes.has(short)) return undefined;
    if (entry.inProgress.has(short))
      throw modelError("extends_cycle", `scalar type "${keyOf(entry, short)}" extends itself`);
    return processScalarType(entry, short);
  }

  function resolveIn<T>(
    name: string,
    from: Entry | undefined,
    get: (entry: Entry, short: string) => T | undefined,
  ): ResolvedName<T> | undefined {
    const located = locate(name, from);
    if (!located) return undefined;
    const definition = get(located.entry, located.short);
    return definition === undefined
      ? undefined
      : { module: located.entry, definition, key: keyOf(located.entry, located.short) };
  }

  function contextOf(from: Entry | undefined): TypeResolutionContext {
    return {
      resolveSchema: (name) => resolveIn(name, from, schemaOf)?.definition,
      resolveScalarType: (name) =>
        isBaseScalarType(name) ? undefined : resolveIn(name, from, scalarTypeOf)?.definition,
      builtinScalarTypes: false,
    };
  }
  const canonicalContext = contextOf(undefined);

  /** The canonical `extends` of a schema, processed or not. */
  function extendsOf(entry: Entry, short: string): string | null {
    const done = entry.schemas.get(short);
    if (done) return done.extends;
    const raw = entry.authoredSchemas.get(short)?.extends;
    return typeof raw === "string" ? canonical(raw, entry) : null;
  }

  function checkExtendsChain(entry: Entry, short: string): void {
    const self = keyOf(entry, short);
    const seen = new Set<string>([self]);
    let current = extendsOf(entry, short);
    while (current) {
      if (seen.has(current))
        throw modelError("extends_cycle", `schema "${self}" extends itself through "${current}"`);
      seen.add(current);
      const located = locate(current, undefined);
      if (!located) return;
      current = extendsOf(located.entry, located.short);
    }
  }

  function processSchema(entry: Entry, short: string): NormalizedSchema {
    const raw = entry.authoredSchemas.get(short) as Record<string, TransientValue>;
    checkExtendsChain(entry, short);
    const authored: TransientObject = { ...raw };
    if (typeof raw.extends === "string") authored.extends = canonical(raw.extends, entry);
    if (typeof raw.facet_of === "string") authored.facet_of = canonical(raw.facet_of, entry);
    // the schema an `exists` rule names is written in the module, like a property type
    if (Array.isArray(raw.checks)) {
      authored.checks = raw.checks.map((check) =>
        isPlainObject(check) && isPlainObject(check.exists) && typeof check.exists.schema === "string"
          ? { ...check, exists: { ...check.exists, schema: canonical(check.exists.schema, entry) } }
          : check,
      );
    }
    if (Array.isArray(raw.properties)) {
      authored.properties = raw.properties.map((p) =>
        isPlainObject(p) && typeof p.type === "string"
          ? { ...p, type: canonicalType(p.type, entry) }
          : p,
      );
    }
    entry.inProgress.add(short);
    try {
      const normalized = processSchemaDescription(authored, canonicalContext);
      // every reference resolves: a short name of another module does not
      for (const prop of normalized.properties) resolveType(prop.type, canonicalContext);
      entry.schemas.set(short, normalized);
      return normalized;
    } finally {
      entry.inProgress.delete(short);
    }
  }

  function processScalarType(entry: Entry, short: string): NormalizedScalarType {
    const raw = entry.authoredScalarTypes.get(short) as Record<string, TransientValue>;
    const authored: TransientObject = { ...raw };
    if (typeof raw.extends === "string") authored.extends = canonical(raw.extends, entry);
    entry.inProgress.add(short);
    try {
      const normalized = processScalarTypeDescription(authored, canonicalContext.resolveScalarType);
      if (normalized.extends && !isBaseScalarType(normalized.extends))
        resolveType(normalized.extends, canonicalContext);
      entry.scalarTypes.set(short, normalized);
      return normalized;
    } finally {
      entry.inProgress.delete(short);
    }
  }

  for (const entry of byKey.values()) {
    for (const short of entry.authoredScalarTypes.keys()) scalarTypeOf(entry, short);
    for (const short of entry.authoredSchemas.keys()) schemaOf(entry, short);
  }
  for (const entry of byKey.values()) checkActionDeclarations(entry);
  for (const entry of byKey.values()) checkSkillUses(entry);
  for (const entry of byKey.values()) checkTopicUses(entry);

  /**
   * The check of Schema Processing, *Skills*, that needs the module set: each
   * name of `uses` is an action, declared or generated, of the module or of a
   * dependency of it in the set. A breach is a `constraint_violation`.
   */
  function checkSkillUses(entry: Entry): void {
    checkUses(entry, "skill", (entry.manifest as ModuleManifest).skills ?? []);
  }

  /** The same check for the `uses` of the documentation topics of a module (Schema Processing, *Topics*). */
  function checkTopicUses(entry: Entry): void {
    checkUses(entry, "topic", (entry.manifest as ModuleManifest).docs ?? []);
  }

  function checkUses(entry: Entry, what: string, skills: ReadonlyArray<{ id: string; uses: string[] }>): void {
    if (skills.length === 0) return;
    const reachable = new Map<string, Entry>([[entry.namespace, entry]]);
    for (const key of entry.dependencyKeys) {
      const dependency = byKey.get(key);
      if (dependency) reachable.set(dependency.namespace, dependency);
    }
    const idsOf = new Map<Entry, Set<string>>();
    const actionsOf = (owner: Entry): Set<string> => {
      let ids = idsOf.get(owner);
      if (!ids) {
        ids = new Set([...owner.actions.keys(), ...generatedActionIds(owner)]);
        idsOf.set(owner, ids);
      }
      return ids;
    };
    for (const skill of skills) {
      for (const name of skill.uses) {
        const owner = reachable.get(name.slice(0, name.indexOf("/")));
        if (!owner || !actionsOf(owner).has(name)) {
          throw modelError(
            "constraint_violation",
            `module "${entry.key}": ${what} "${skill.id}" uses "${name}", not an action of the module or of a dependency`,
          );
        }
      }
    }
  }

  /**
   * The checks of Schema Processing, *Actions*, each breach a
   * `constraint_violation`: a `crud` or an `updated_by` names an action of the
   * module, `crud` offers no create or delete on a facet or a singleton,
   * `updated_by` is not set on a constant property, and `writes` names schemas
   * of the module. A declaration of another module cannot reach a schema: a
   * manifest holds only its own, and neither `crud` nor a checked `updated_by`
   * comes through `extends`.
   */
  function checkActionDeclarations(entry: Entry): void {
    const fail = (message: string): never => {
      throw modelError("constraint_violation", `module "${entry.key}": ${message}`);
    };
    const isAction = (id: unknown) => typeof id === "string" && entry.actions.has(id);
    for (const [short, schema] of entry.schemas) {
      const crud = schema.constraints.crud;
      if (crud !== undefined) {
        if (!isPlainObject(crud)) fail(`the crud of "${short}" must be a mapping`);
        const facetOrSingleton =
          typeof schema.constraints.facet_of === "string" || schema.constraints.singleton === true;
        for (const [operation, value] of Object.entries(crud as Record<string, TransientValue>)) {
          if (!["create", "update", "delete"].includes(operation))
            fail(`the crud of "${short}" has an unknown operation "${operation}"`);
          if (value !== "generated" && value !== "none" && !isAction(value))
            fail(`the crud of "${short}" names ${JSON.stringify(value)}, not an action of the module`);
          if (operation !== "update" && value !== "none" && facetOrSingleton)
            fail(`"${short}" is a facet or a singleton and offers no ${operation}`);
        }
      }
      const parent = schema.extends ? canonicalContext.resolveSchema(schema.extends) : undefined;
      for (const prop of schema.properties) {
        const updatedBy = prop.constraints.updated_by;
        if (updatedBy === undefined) continue;
        if (parent?.properties.some((p) => p.name === prop.name && p.constraints.updated_by === updatedBy)) continue;
        if (!isAction(updatedBy))
          fail(`"${short}.${prop.name}" is updated by ${JSON.stringify(updatedBy)}, not an action of the module`);
        if (prop.constraints.constant === true)
          fail(`"${short}.${prop.name}" is constant and cannot have an "updated_by"`);
      }
    }
    for (const [id, action] of entry.actions) {
      if (action.writes === undefined || action.writes === null) continue;
      if (!Array.isArray(action.writes)) fail(`the writes of "${id}" must be a list`);
      for (const name of action.writes as TransientValue[]) {
        let owner: Entry | undefined;
        try {
          owner = typeof name === "string" ? locate(name, entry)?.entry : undefined;
          if (owner && !schemaOf(owner, (locate(name as string, entry) as { short: string }).short)) owner = undefined;
        } catch {
          owner = undefined;
        }
        if (owner !== entry) fail(`"${id}" writes ${JSON.stringify(name)}, not a schema of the module`);
      }
    }
  }

  const modules = [...byKey.values()];
  return {
    modules,
    module: (key) => byKey.get(key),
    resolveSchema: (name, from) => resolveIn(name, entryOf(from), schemaOf),
    resolveScalarType: (name, from) =>
      isBaseScalarType(name) ? undefined : resolveIn(name, entryOf(from), scalarTypeOf),
    requireSchema(name, from) {
      const resolved = resolveIn(name, entryOf(from), schemaOf);
      if (!resolved) {
        throw modelError(
          "unknown_schema",
          `"${name}" names no schema ${from === undefined ? "outside a module" : `in module "${from}"`}`,
        );
      }
      return resolved;
    },
    context: (from) => contextOf(entryOf(from)),
  };
}
