import { describe, expect, it } from "vitest";
import { ModelError } from "../src/errors.js";
import { SCHEMA_ROLES, derivePropertyRoles, processSchemaDescription, resolveType } from "../src/schemaProcessing.js";
import type { TypeResolutionContext } from "../src/schemaProcessing.js";
import type { NormalizedSchema, NormalizedScalarType } from "../src/types.js";

/**
 * Tests for the is_content/is_folder property constraints (property roles),
 * per document_part-definition-property_constraints.md's "Property roles"
 * and the `getInstance` doc comment of `PersistenceInterface` —
 * at most one property per schema may carry each, is_content's property must
 * resolve to "markdown", is_folder's to any string-based scalar type.
 */

function ctxWith(schemas: Record<string, NormalizedSchema> = {}, scalarTypes: Record<string, NormalizedScalarType> = {}): TypeResolutionContext {
  return {
    resolveSchema: (name) => schemas[name],
    resolveScalarType: (name) => scalarTypes[name],
  };
}

function expectConstraintViolation(fn: () => unknown): void {
  try {
    fn();
    expect.fail("expected a constraint_violation");
  } catch (err) {
    expect(err).toBeInstanceOf(ModelError);
    expect((err as ModelError).code).toBe("constraint_violation");
  }
}

describe("resolveType — dataset/overlay scalar types win over the builtin placeholder", () => {
  it("a resolver-declared identifier with a real pattern wins over BUILTIN_SCALAR_TYPES' empty-pattern placeholder", () => {
    const ctx = ctxWith(
      {},
      { identifier: { name: "identifier", extends: "string", constraints: { pattern: "^[A-Za-z_][A-Za-z0-9_]*$" } } },
    );
    const resolved = resolveType("identifier", ctx);
    expect(resolved.kind).toBe("scalar");
    if (resolved.kind === "scalar") {
      expect(resolved.constraints.pattern).toBe("^[A-Za-z_][A-Za-z0-9_]*$");
    }
  });

  it("falls back to the builtin placeholder when the resolver declares nothing", () => {
    const ctx = ctxWith({}, {});
    const resolved = resolveType("identifier", ctx);
    expect(resolved.kind).toBe("scalar");
    if (resolved.kind === "scalar") {
      expect(resolved.constraints.pattern).toBe("");
    }
  });
});

describe("processSchemaDescription — property roles", () => {
  it("accepts a schema with no role-marked properties", () => {
    const schema = processSchemaDescription({ name: "task", properties: [{ name: "title", type: "string" }] }, ctxWith());
    expect(derivePropertyRoles(schema)).toEqual({});
  });

  it("accepts a single is_content property typed markdown", () => {
    const schema = processSchemaDescription(
      { name: "note", properties: [{ name: "body", type: "markdown", is_content: true }] },
      ctxWith(),
    );
    expect(derivePropertyRoles(schema)).toEqual({ content: "body" });
  });

  it("accepts a single is_folder property typed string", () => {
    const schema = processSchemaDescription(
      { name: "note", properties: [{ name: "path", type: "string", is_folder: true }] },
      ctxWith(),
    );
    expect(derivePropertyRoles(schema)).toEqual({ folder: "path" });
  });

  it("accepts is_folder on a string-based scalar type, not just plain string", () => {
    const schema = processSchemaDescription(
      { name: "note", properties: [{ name: "path", type: "identifier", is_folder: true }] },
      ctxWith(),
    );
    expect(derivePropertyRoles(schema)).toEqual({ folder: "path" });
  });

  it("accepts a custom scalar type extending markdown for is_content", () => {
    const releaseNotes: NormalizedScalarType = { name: "release_notes", extends: "markdown", constraints: {} };
    const schema = processSchemaDescription(
      { name: "release", properties: [{ name: "notes", type: "release_notes", is_content: true }] },
      ctxWith({}, { release_notes: releaseNotes }),
    );
    expect(derivePropertyRoles(schema)).toEqual({ content: "notes" });
  });

  it("accepts both roles on the same schema, on different properties", () => {
    const schema = processSchemaDescription(
      {
        name: "note",
        properties: [
          { name: "body", type: "markdown", is_content: true },
          { name: "path", type: "string", is_folder: true },
        ],
      },
      ctxWith(),
    );
    expect(derivePropertyRoles(schema)).toEqual({ content: "body", folder: "path" });
  });

  it("rejects a second is_content property on the same schema", () => {
    expectConstraintViolation(() =>
      processSchemaDescription(
        {
          name: "note",
          properties: [
            { name: "body", type: "markdown", is_content: true },
            { name: "summary", type: "markdown", is_content: true },
          ],
        },
        ctxWith(),
      ),
    );
  });

  it("rejects a second is_folder property on the same schema", () => {
    expectConstraintViolation(() =>
      processSchemaDescription(
        {
          name: "note",
          properties: [
            { name: "path_a", type: "string", is_folder: true },
            { name: "path_b", type: "string", is_folder: true },
          ],
        },
        ctxWith(),
      ),
    );
  });

  it("rejects is_content on a non-markdown property", () => {
    expectConstraintViolation(() =>
      processSchemaDescription({ name: "note", properties: [{ name: "body", type: "string", is_content: true }] }, ctxWith()),
    );
  });

  it("rejects is_folder on a non-string-based property", () => {
    expectConstraintViolation(() =>
      processSchemaDescription({ name: "note", properties: [{ name: "priority", type: "integer", is_folder: true }] }, ctxWith()),
    );
  });

  it("rejects is_content on a relation property", () => {
    const person: NormalizedSchema = { name: "person", description: "", content: "", extends: null, cannot_be_extended: false, properties: [], constraints: {} };
    expectConstraintViolation(() =>
      processSchemaDescription({ name: "note", properties: [{ name: "author", type: "person", is_content: true }] }, ctxWith({ person })),
    );
  });

  it("rejects is_content on an array property — a single instance has only one body", () => {
    expectConstraintViolation(() =>
      processSchemaDescription(
        { name: "note", properties: [{ name: "body", type: "markdown", is_array: true, is_content: true }] },
        ctxWith(),
      ),
    );
  });

  it("rejects is_folder on an array property", () => {
    expectConstraintViolation(() =>
      processSchemaDescription(
        { name: "note", properties: [{ name: "path", type: "string", is_array: true, is_folder: true }] },
        ctxWith(),
      ),
    );
  });

  it("counts an inherited is_content property toward the same-schema limit", () => {
    const base = processSchemaDescription({ name: "note", properties: [{ name: "body", type: "markdown", is_content: true }] }, ctxWith());
    expectConstraintViolation(() =>
      processSchemaDescription(
        { name: "special_note", extends: "note", properties: [{ name: "summary", type: "markdown", is_content: true }] },
        ctxWith({ note: base }),
      ),
    );
  });

  it("lets a subclass add is_folder when the parent only has is_content", () => {
    const base = processSchemaDescription({ name: "note", properties: [{ name: "body", type: "markdown", is_content: true }] }, ctxWith());
    const sub = processSchemaDescription(
      { name: "filed_note", extends: "note", properties: [{ name: "path", type: "string", is_folder: true }] },
      ctxWith({ note: base }),
    );
    expect(derivePropertyRoles(sub)).toEqual({ content: "body", folder: "path" });
  });
});

describe("processSchemaDescription — relations are single-valued", () => {
  /**
   * `relations` part:
   * "A directly declared relation is always single-valued: is_array cannot
   * be set on a relation property ... A relation reaching several instances
   * only exists as a virtual relation, generated on the target schema from
   * inverse_is_array ... In consequence a many-to-many relationship cannot
   * be declared directly: it must be reified as its own schema, holding a
   * direct relation to each side."
   */
  it("rejects is_array on a relation property with constraint_violation", () => {
    const bucket: NormalizedSchema = { name: "bucket", description: "", content: "", extends: null, cannot_be_extended: false, properties: [], constraints: {} };
    expectConstraintViolation(() =>
      processSchemaDescription({ name: "item", properties: [{ name: "bucket", type: "bucket", is_array: true }] }, ctxWith({ bucket })),
    );
  });

  it("rejects is_array on a relation property even combined with inverse_is_array — a many-to-many relationship can't be declared directly on either side", () => {
    const bucket: NormalizedSchema = { name: "bucket", description: "", content: "", extends: null, cannot_be_extended: false, properties: [], constraints: {} };
    expectConstraintViolation(() =>
      processSchemaDescription(
        { name: "item", properties: [{ name: "buckets", type: "bucket", is_array: true, inverse_name: "items", inverse_is_array: true }] },
        ctxWith({ bucket }),
      ),
    );
  });

  it("still accepts is_array on a scalar property — the restriction is relations-only", () => {
    const schema = processSchemaDescription({ name: "task", properties: [{ name: "tags", type: "string", is_array: true }] }, ctxWith());
    expect(schema.properties.find((p) => p.name === "tags")?.constraints.is_array).toBe(true);
  });
});

describe("processSchemaDescription — extends inherits a generated relation", () => {
  /**
   * A virtual/generated inverse relation —
   * constraints.__generated: true, materialized onto a schema by
   * applyInverseRelations (modelUpgrade.ts) from another schema's
   * inverse_name, never authored directly — is legitimately an is_array
   * relation: the `relations` part's "A relation reaching
   * several instances only exists as a virtual relation, generated on the
   * target schema from inverse_is_array" is exactly this case.
   *
   * validateRelationsAreSingleValued (schemaProcessing.ts) exempts a
   * "__generated" relation: once a parent schema has picked up such a property
   * (e.g. "document" gains "sections" once document_section.owning_document
   * declares inverse_name: sections, inverse_is_array: true), extends
   * resolution's own property merge copies that property into every
   * extending child (e.g. document_convention extends document), and
   * processSchemaDescription on that child must not throw, even though the
   * child's own authored description never names the property at all.
   */
  it("does not reject a property inherited through extends that is a generated (virtual) is_array relation", () => {
    const document_section: NormalizedSchema = {
      name: "document_section",
      description: "",
      content: "",
      extends: null,
      cannot_be_extended: false,
      properties: [],
      constraints: {},
    };
    // Mirrors what applyInverseRelations actually stores on "document" once
    // document_section.owning_document declares inverse_name: sections,
    // inverse_is_array: true, owner: false — see modelUpgrade.ts.
    const document: NormalizedSchema = {
      name: "document",
      description: "",
      content: "",
      extends: null,
      cannot_be_extended: false,
      properties: [
        {
          name: "sections",
          type: "document_section",
          default_value: null,
          null_value: null,
          constraints: { is_array: true, mandatory: false, owner: false, __generated: true },
        },
      ],
      constraints: {},
    };
    const ctx = ctxWith({ document, document_section });

    let child!: NormalizedSchema;
    expect(() => {
      child = processSchemaDescription({ name: "document_convention", extends: "document" }, ctx);
    }).not.toThrow();

    expect(child).toBeDefined();
    const sections = child.properties.find((p) => p.name === "sections");
    expect(sections).toBeDefined();
    expect(sections?.constraints.__generated).toBe(true);
    expect(sections?.constraints.is_array).toBe(true);
  });
});

describe("derivePropertyRoles", () => {
  it("returns {} for a schema with no role-marked properties", () => {
    const schema: NormalizedSchema = {
      name: "task",
      description: "",
      content: "",
      extends: null,
      cannot_be_extended: false,
      properties: [{ name: "title", type: "string", default_value: null, null_value: null, constraints: {} }],
      constraints: {},
    };
    expect(derivePropertyRoles(schema)).toEqual({});
  });

  /**
   * The `schema` meta-schema marks its own `content` property `is_content`
   * (document_part-definition-schema.md), so a `schema` instance travels to a
   * PersistenceInterface with a content role like any other instance — this is
   * what every `schema` call site passes instead of NO_ROLES.
   */
  it("SCHEMA_ROLES is the schema meta-schema's own content role", () => {
    expect(SCHEMA_ROLES).toEqual({ content: "content" });
  });
});

describe("processSchemaDescription — content", () => {
  it("carries a schema's own content, empty when unstated", () => {
    expect(processSchemaDescription({ name: "part", content: "a body" }, ctxWith()).content).toBe("a body");
    expect(processSchemaDescription({ name: "part" }, ctxWith()).content).toBe("");
  });

  it("reads content as a declared property rather than a constraint", () => {
    expect(processSchemaDescription({ name: "part", content: "a body" }, ctxWith()).constraints.content).toBeUndefined();
  });

  it("leaves content out of what extends carries over — a schema's content describes that schema", () => {
    const base = processSchemaDescription({ name: "part", content: "a body" }, ctxWith());
    expect(processSchemaDescription({ name: "kind", extends: "part" }, ctxWith({ part: base })).content).toBe("");
  });
});

/**
 * Overriding an inherited property, per document_part-feature-schema_processing.md's
 * "Extends resolution": an own entry naming a property the parent already
 * declares refines it — what it states wins, what it leaves out carries
 * through — so `type` is optional there and only there, and restating it as
 * anything but the inherited type is rejected.
 */
describe("processSchemaDescription — property override", () => {
  const base: NormalizedSchema = {
    name: "part",
    description: "",
    content: "",
    extends: null,
    cannot_be_extended: false,
    properties: [
      { name: "notation", type: "string", default_value: null, null_value: null, constraints: { mandatory: true } },
      { name: "title", type: "string", default_value: "untitled", null_value: null, constraints: {} },
    ],
    constraints: { shared_by_name: true },
  };
  const ctx = ctxWith({ part: base });

  it("narrows an inherited property's default without restating its type", () => {
    const sub = processSchemaDescription({ name: "schema_part", extends: "part", properties: [{ name: "notation", default_value: "yaml" }] }, ctx);
    const notation = sub.properties.find((p) => p.name === "notation");
    expect(notation).toEqual({ name: "notation", type: "string", default_value: "yaml", null_value: null, constraints: { mandatory: true } });
    // Everything the override didn't mention is still there, in place.
    expect(sub.properties.map((p) => p.name)).toEqual(["notation", "title"]);
    expect(sub.properties.find((p) => p.name === "title")?.default_value).toBe("untitled");
  });

  it("layers an override's constraints on top of the inherited ones", () => {
    const sub = processSchemaDescription(
      { name: "schema_part", extends: "part", properties: [{ name: "notation", mandatory: false, pattern: "^[a-z]+$" }] },
      ctx,
    );
    expect(sub.properties.find((p) => p.name === "notation")?.constraints).toEqual({ mandatory: false, pattern: "^[a-z]+$" });
  });

  it("accepts an override restating the inherited type", () => {
    const sub = processSchemaDescription({ name: "schema_part", extends: "part", properties: [{ name: "notation", type: "string", default_value: "yaml" }] }, ctx);
    expect(sub.properties.find((p) => p.name === "notation")?.type).toBe("string");
  });

  it("rejects an override that retypes the inherited property", () => {
    try {
      processSchemaDescription({ name: "schema_part", extends: "part", properties: [{ name: "notation", type: "integer" }] }, ctx);
      expect.fail("expected a property_type_change");
    } catch (err) {
      expect(err).toBeInstanceOf(ModelError);
      expect((err as ModelError).code).toBe("property_type_change");
    }
  });

  it("still requires a type on a property with nothing to inherit from", () => {
    expectConstraintViolation(() => processSchemaDescription({ name: "loose", properties: [{ name: "notation", default_value: "yaml" }] }, ctxWith()));
    expectConstraintViolation(() =>
      processSchemaDescription({ name: "schema_part", extends: "part", properties: [{ name: "brand_new", default_value: "x" }] }, ctx),
    );
  });
});

/**
 * `processPropertyDescription` accepts an authored `default_value`/`null_value`
 * of any of string/number/boolean (a boolean or integer literal is how a
 * caller naturally authors `default_value: true` or `default_value: 10`) and
 * normalizes it to the `string | null` storage form `coerceScalar` expects at
 * instance-construction time (command.ts); the override is never dropped in
 * favour of the parent's default (`inherited?.default_value ?? null`).
 */
describe("processSchemaDescription — property override (non-string default_value/null_value)", () => {
  const typedBase: NormalizedSchema = {
    name: "table_representation",
    description: "",
    content: "",
    extends: null,
    cannot_be_extended: false,
    properties: [
      { name: "creatable", type: "boolean", default_value: "false", null_value: null, constraints: {} },
      { name: "order", type: "integer", default_value: "0", null_value: null, constraints: {} },
    ],
    constraints: {},
  };
  const typedCtx = ctxWith({ table_representation: typedBase });

  it("narrows an inherited boolean property's default_value to true", () => {
    const sub = processSchemaDescription(
      { name: "person_table", extends: "table_representation", properties: [{ name: "creatable", default_value: true }] },
      typedCtx,
    );
    expect(sub.properties.find((p) => p.name === "creatable")?.default_value).toBe("true");
  });

  it("narrows an inherited integer property's default_value to a non-zero number", () => {
    const sub = processSchemaDescription(
      { name: "name_column", extends: "table_representation", properties: [{ name: "order", default_value: 10 }] },
      typedCtx,
    );
    expect(sub.properties.find((p) => p.name === "order")?.default_value).toBe("10");
  });

  it("accepts a boolean default_value on a brand-new property, not just an override", () => {
    const schema = processSchemaDescription({ name: "flag_holder", properties: [{ name: "enabled", type: "boolean", default_value: true }] }, ctxWith());
    expect(schema.properties.find((p) => p.name === "enabled")?.default_value).toBe("true");
  });

  it("accepts an integer default_value on a brand-new property", () => {
    const schema = processSchemaDescription({ name: "counter_holder", properties: [{ name: "count", type: "integer", default_value: 20 }] }, ctxWith());
    expect(schema.properties.find((p) => p.name === "count")?.default_value).toBe("20");
  });

  it("narrows an inherited property's null_value the same way, for a non-string type", () => {
    const sub = processSchemaDescription(
      { name: "name_column", extends: "table_representation", properties: [{ name: "order", null_value: -1 }] },
      typedCtx,
    );
    expect(sub.properties.find((p) => p.name === "order")?.null_value).toBe("-1");
  });

  it("rejects a default_value that has no sensible string form", () => {
    expectConstraintViolation(() =>
      processSchemaDescription({ name: "bad_holder", properties: [{ name: "tags", type: "string", default_value: ["a", "b"] }] }, ctxWith()),
    );
  });
});
