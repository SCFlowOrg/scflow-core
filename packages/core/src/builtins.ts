import type { NormalizedScalarType, NormalizedSchema } from "./types.js";

/**
 * Built into the interpreter (the "meta-model"), per
 * document_part-concept-transient_language.md / document_part-feature-scalar_types.md.
 * Never stored in a dataset, always resolvable by name ahead of the dataset's own
 * schemas and scalar types.
 */

/** The four base scalar types every scalar type ultimately extends: `string`, `number`, `integer` and `boolean`. */
export const BASE_SCALAR_TYPES = ["string", "number", "integer", "boolean"] as const;
export type BaseScalarType = (typeof BASE_SCALAR_TYPES)[number];

/** Whether `name` is one of `BASE_SCALAR_TYPES`. */
export function isBaseScalarType(name: string): name is BaseScalarType {
  return (BASE_SCALAR_TYPES as readonly string[]).includes(name);
}

/** The type's own default value, per the Scalar Types table. */
export function baseScalarDefault(base: BaseScalarType): string | number | boolean {
  switch (base) {
    case "string":
      return "";
    case "number":
      return 0;
    case "integer":
      return 0;
    case "boolean":
      return false;
  }
}

/** The type's own null value — same as default, except boolean, per Property's doc. */
export function baseScalarNull(base: BaseScalarType): string | number | boolean | null {
  return base === "boolean" ? true : baseScalarDefault(base);
}

/**
 * String refinements "built into the meta-model" per document_part-feature-scalar_types.md,
 * plus `markdown` — used as a property `type` in the worked examples
 * (document_part-feature-command_examples.md's `comment.body`) and named as a string
 * constraint in the same doc ("the string contains markdown formatting"). The spec's
 * builtin list doesn't include it explicitly; adding it as extends-string with
 * `markdown: true` is the natural reading and is called out here so it's easy to revisit.
 */
export const BUILTIN_SCALAR_TYPES: Record<string, NormalizedScalarType> = {
  // `uuid` below keeps its placeholder pattern, so existing `uuid` properties are not
  // re-validated; UUID_PATTERN (ids.ts) checks only the `id` a `create` supplies.
  date: { name: "date", extends: "string", constraints: { pattern: "" } },
  date_time: { name: "date_time", extends: "string", constraints: { pattern: "" } },
  time: { name: "time", extends: "string", constraints: { pattern: "" } },
  identifier: { name: "identifier", extends: "string", constraints: { pattern: "" } },
  email: { name: "email", extends: "string", constraints: { pattern: "" } },
  uuid: { name: "uuid", extends: "string", constraints: { pattern: "" } },
  markdown: { name: "markdown", extends: "string", constraints: { markdown: true } },
  // The key type of `localized_string` and `localized_markdown`: a language, optionally with a region (en, fr, pt-BR).
  // Unlike the placeholders above it carries its real pattern, so a map keyed by it is checked whatever the format.
  language_code: { name: "language_code", extends: "string", constraints: { pattern: "^[a-z]{2}(-[A-Z]{2})?$" } },
};

/**
 * Meta-schemas for `schema`, `scalar_type`, and `dataset` themselves, hard-coded rather
 * than bootstrapped through Schema Processing (which would need them to already exist).
 * This lets `runCommand({schema: "schema", kind: "query", ...})` work like any other
 * schema, per the `PersistenceInterface` doc comment, without
 * requiring a self-referential bootstrap pass. `property` is intentionally not listed
 * here — it is always `embedded` within a schema's `properties`, never an independently
 * addressable/queryable instance schema.
 */
export const META_SCHEMAS: Record<string, NormalizedSchema> = {
  schema: {
    name: "schema",
    description: "the meta-schema for all schemas",
    content: "",
    extends: null,
    cannot_be_extended: true,
    properties: [
      { name: "name", type: "identifier", default_value: null, null_value: null, constraints: {} },
      { name: "description", type: "markdown", default_value: "", null_value: "", constraints: {} },
      { name: "content", type: "markdown", default_value: "", null_value: "", constraints: { is_content: true } },
      {
        name: "extends",
        type: "schema",
        default_value: null,
        null_value: null,
        constraints: { inverse_name: "extended_by", inverse_is_array: true },
      },
      { name: "cannot_be_extended", type: "boolean", default_value: null, null_value: null, constraints: {} },
      { name: "properties", type: "property", default_value: null, null_value: null, constraints: { is_array: true } },
      {
        name: "constraints",
        type: "constraint_value",
        default_value: null,
        null_value: null,
        constraints: { is_array: true },
      },
    ],
    constraints: { shared_by_name: true, has_description: true, is_root: true },
  },
  scalar_type: {
    name: "scalar_type",
    description: "a named refinement of a base scalar type, built from constraints",
    content: "",
    extends: null,
    cannot_be_extended: false,
    properties: [
      { name: "name", type: "identifier", default_value: null, null_value: null, constraints: {} },
      { name: "extends", type: "scalar_type", default_value: null, null_value: null, constraints: {} },
      {
        name: "constraints",
        type: "constraint_value",
        default_value: null,
        null_value: null,
        constraints: { is_array: true },
      },
    ],
    constraints: { shared_by_name: true, is_root: true },
  },
  dataset: {
    name: "dataset",
    description: "the dataset itself — a singleton",
    content: "",
    extends: null,
    cannot_be_extended: true,
    properties: [
      { name: "name", type: "identifier", default_value: null, null_value: null, constraints: {} },
      { name: "model_major_version", type: "integer", default_value: null, null_value: null, constraints: {} },
      { name: "model_minor_version", type: "integer", default_value: null, null_value: null, constraints: {} },
      { name: "data_major_version", type: "integer", default_value: null, null_value: null, constraints: {} },
      { name: "data_minor_version", type: "integer", default_value: null, null_value: null, constraints: {} },
      { name: "created_at", type: "date_time", default_value: null, null_value: null, constraints: {} },
      { name: "updated_at", type: "date_time", default_value: null, null_value: null, constraints: {} },
      { name: "model_only", type: "boolean", default_value: null, null_value: null, constraints: {} },
      {
        name: "schemas",
        type: "schema",
        default_value: null,
        null_value: null,
        constraints: { is_array: true, inverse_name: "dataset", inverse_is_array: false },
      },
      {
        name: "scalar_types",
        type: "scalar_type",
        default_value: null,
        null_value: null,
        constraints: { is_array: true, inverse_name: "dataset", inverse_is_array: false },
      },
    ],
    constraints: { shared_by_name: true, has_description: true, is_root: true, singleton: true },
  },
};
