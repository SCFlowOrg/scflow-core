import type {
  NormalizedProperty,
  NormalizedScalarType,
  NormalizedSchema,
  TransientValue,
} from "./types.js";

/**
 * `mcl:core`, the module of the central concepts of MCL, per
 * packages/core/docs/spec/meta-model.md#the-core-module: the meta-model and the
 * standard scalar types, in the same manifest format as any module.
 *
 * The engine embeds it already normalized, as `schema` describes itself: it is
 * not read through `readModuleManifest`, because the meta-model names types
 * that are built into the engine and have no schema of their own
 * (`constraint_value`, `type_name`, `action_body`, `migration`), and nothing
 * resolves them. Its names are short everywhere.
 *
 * Until datasets use modules, the engine still resolves a dataset's names
 * through `META_SCHEMAS` and `BUILTIN_SCALAR_TYPES` (builtins.ts); this
 * manifest serves the module set (modules.ts).
 */

/** The key of the core module. */
export const MCL_CORE_KEY = "mcl:core";

/** The namespace of the core module, reserved: no other module can declare it. */
export const MCL_NAMESPACE = "mcl";

/** The version of the core module: the version of the specification. */
export const MCL_CORE_VERSION = "1.0.0";

function prop(
  name: string,
  type: string,
  constraints: Record<string, TransientValue> = {},
  default_value: string | null = null,
): NormalizedProperty {
  return { name, type, default_value, null_value: null, constraints };
}

function schema(
  name: string,
  description: string,
  properties: NormalizedProperty[],
  constraints: Record<string, TransientValue> = {},
): NormalizedSchema {
  return {
    name,
    description,
    content: "",
    extends: null,
    cannot_be_extended: constraints.cannot_be_extended === true,
    properties,
    constraints,
  };
}

function stringType(
  name: string,
  constraints: Record<string, TransientValue>,
): NormalizedScalarType {
  return { name, extends: "string", constraints };
}

const array = { is_array: true };

/** The standard scalar types, with the patterns of packages/core/docs/spec/meta-model.md#scalar-types. */
const SCALAR_TYPES: NormalizedScalarType[] = [
  stringType("date", { pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
  stringType("date_time", { pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?Z$" }),
  stringType("time", { pattern: "^\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?$" }),
  stringType("identifier", { pattern: "^[A-Za-z_][A-Za-z0-9_]*$" }),
  stringType("email", { pattern: "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$" }),
  stringType("uuid", { pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$" }),
  stringType("duration", {
    pattern:
      "^P(?=.)((\\d+Y)|(\\d+M)|(\\d+W)|(\\d+D))*(T(?=.)((\\d+H)|(\\d+M)|(\\d+(\\.\\d+)?S))*)?$",
  }),
  stringType("language_code", { pattern: "^[a-z]{2}(-[A-Z]{2})?$" }),
  stringType("module_key", { pattern: "^[a-z][a-z0-9_-]*:[a-z][a-z0-9_-]*$" }),
  stringType("semantic_version", { pattern: "^\\d+\\.\\d+\\.\\d+$" }),
  stringType("version_range", { pattern: "^[\\^~]?\\d+(\\.\\d+){0,2}$" }),
  // the type of `description` and `content` in the meta-model, a string with markdown formatting
  stringType("markdown", { markdown: true }),
];

/** The meta-model: the schemas of packages/core/docs/spec/meta-model.md that describe a model. */
const SCHEMAS: NormalizedSchema[] = [
  schema(
    "schema",
    "the meta-schema for all schemas",
    [
      prop("name", "identifier"),
      prop("description", "markdown"),
      prop("content", "markdown", { is_content: true }),
      prop("extends", "schema", { inverse_name: "extended_by", inverse_is_array: true }),
      prop("cannot_be_extended", "boolean"),
      prop("properties", "property", array),
      prop("constraints", "constraint_value", array),
    ],
    { shared_by_name: true, has_description: true, cannot_be_extended: true },
  ),
  schema(
    "property",
    "the meta-schema for property definitions in a schema",
    [
      prop("name", "identifier"),
      prop("type", "type_name"),
      prop("default_value", "string"),
      prop("null_value", "string"),
      prop("constraints", "constraint_value", array),
    ],
    { embedded: true, has_description: true },
  ),
  schema(
    "constraint",
    "the definition of a constraint, built into the engine",
    [
      prop("name", "identifier"),
      prop("type", "type_name"),
      prop("description", "markdown"),
      prop("default_value", "string"),
    ],
    { embedded: true },
  ),
  schema(
    "scalar_type",
    "a named refinement of a base scalar type, built from constraints",
    [
      prop("name", "identifier"),
      prop("extends", "scalar_type"),
      prop("constraints", "constraint_value", array),
    ],
    { shared_by_name: true, constant: true },
  ),
  schema(
    "dataset",
    "the unit of persistence, holds data and the modules it uses",
    [
      prop("name", "identifier"),
      prop("languages", "language_code", array),
      prop("data_major_version", "integer"),
      prop("data_minor_version", "integer"),
      prop("created_at", "date_time"),
      prop("updated_at", "date_time"),
      prop("modules", "dataset_module", array),
    ],
    { shared_by_name: true, has_description: true, singleton: true },
  ),
  schema(
    "dataset_module",
    "a module a dataset uses, at the version the dataset was written against",
    [prop("module", "module_key"), prop("version", "semantic_version"), prop("digest", "string")],
    { embedded: true },
  ),
  schema(
    "import",
    "a composition of the data of another dataset into this one",
    [
      prop("name", "identifier"),
      prop("locator", "string"),
      prop("namespace", "string"),
      prop("data_major_version", "integer"),
      prop("data_minor_version", "integer"),
      prop("caching_policy", "string", { enum: ["full", "partial", "none"] }, "full"),
    ],
    { shared_by_name: true, is_root: true, has_description: true },
  ),
  schema(
    "module",
    "the unit that contributes schemas, scalar types and actions to a model",
    [
      prop("name", "module_key"),
      prop("namespace", "identifier"),
      prop("version", "semantic_version"),
      prop("mcl", "version_range"),
      prop("title", "string"),
      prop("dependencies", "module_dependency", array),
      prop("schemas", "schema", { ...array, owns: true }),
      prop("scalar_types", "scalar_type", { ...array, owns: true }),
      prop("actions", "action", { ...array, owns: true }),
      prop("skills", "skill", { ...array, owns: true }),
      prop("migrations", "migration", array),
    ],
    { shared_by_name: true },
  ),
  schema(
    "module_dependency",
    "a module another module depends on, with the versions it accepts",
    [prop("module", "module_key"), prop("version", "version_range")],
    { embedded: true },
  ),
  schema("action", "an operation of a module, declared apart from its body", [
    prop("id", "string"),
    prop("title", "string"),
    prop("description", "string"),
    prop("kind", "string", { enum: ["read", "action"] }, "action"),
    prop("destructive", "boolean"),
    prop("exposure", "string", { enum: ["visible", "hidden"] }, "visible"),
    prop("parameters", "string"),
    prop("writes", "schema", array),
    prop("body", "action_body"),
  ]),
  schema("skill", "a method of a module, in Markdown, that an AI assistant loads on demand", [
    prop("id", "string"),
    prop("title", "string"),
    prop("description", "string"),
    prop("uses", "string", array),
    prop("exposure", "string", { enum: ["visible", "hidden"] }, "visible"),
    prop("file", "string"),
  ]),
];

/** The shape of a module manifest, `module.yaml`, once validated against the `module` schema. */
export interface ModuleManifest {
  /** The key of the module, `publisher:module`. */
  name: string;
  /** The prefix of the names of this module outside it. */
  namespace: string;
  /** The semantic version of the module. */
  version: string;
  /** The range of versions of `mcl:core` this module works with. */
  mcl: string;
  title: string;
  dependencies: ModuleDependency[];
  /** The schemas of the module, as authored: each is processed when the module joins a module set. */
  schemas: Array<Record<string, TransientValue>>;
  /** The scalar types of the module, as authored. */
  scalar_types: Array<Record<string, TransientValue>>;
  /** The actions the module declares, their `id`, `kind` and `exposure` checked, the rest as authored. */
  actions: Array<Record<string, TransientValue>>;
  /**
   * The skills the module declares, checked as instances of `skill`; absent
   * when it declares none, so the digest of a module without skills does not
   * depend on this section.
   */
  skills?: ModuleSkill[];
  /** The migrations of the module, as authored; `upgradeModule` runs those it needs, by their `to` (see `migrations.ts`). */
  migrations: TransientValue[];
}

/** A skill of a module: a method in Markdown that an AI assistant loads on demand (see Skill in `docs/spec/meta-model.md`). */
export interface ModuleSkill {
  /** The namespace of the module, a slash and a name, such as `scflow/image_to_model`. */
  id: string;
  title: string;
  /** When to use the skill. */
  description: string;
  /** The ids of the actions the skill relies on. */
  uses: string[];
  exposure: "visible" | "hidden";
  /** The path of the body, a Markdown file of the module package. */
  file: string;
}

/** A module another module depends on, with the versions it accepts. */
export interface ModuleDependency {
  module: string;
  version: string;
}

/** The manifest of `mcl:core`: a module manifest whose schemas and scalar types are already normalized. */
export interface CoreManifest extends Omit<ModuleManifest, "schemas" | "scalar_types"> {
  schemas: NormalizedSchema[];
  scalar_types: NormalizedScalarType[];
}

/**
 * The manifest of `mcl:core`. Unlike any other manifest, its `schemas` and
 * `scalar_types` are already normalized.
 */
export const MCL_CORE: CoreManifest = {
  name: MCL_CORE_KEY,
  namespace: MCL_NAMESPACE,
  version: MCL_CORE_VERSION,
  mcl: MCL_CORE_VERSION,
  title: "MCL core",
  dependencies: [],
  schemas: SCHEMAS,
  scalar_types: SCALAR_TYPES,
  actions: [],
  migrations: [],
};
