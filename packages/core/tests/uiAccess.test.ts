import { describe, expect, it } from "vitest";
import { ModelError } from "../src/errors.js";
import { processSchemaDescription } from "../src/schemaProcessing.js";
import type { TypeResolutionContext } from "../src/schemaProcessing.js";
import { uiAccessOf } from "../src/uiAccess.js";
import type { UiAccess } from "../src/uiAccess.js";
import type { NormalizedProperty, NormalizedSchema, TransientValue } from "../src/types.js";

/**
 * uiAccessOf: the level a user interface may expose a schema, or one of its
 * properties, from the `ui_access` constraint.
 */

const ctx: TypeResolutionContext = { resolveSchema: () => undefined, resolveScalarType: () => undefined };

function schemaOf(description: Record<string, unknown>): NormalizedSchema {
  return processSchemaDescription(description as TransientValue, ctx);
}

/** A schema built directly, for properties Schema Processing does not author. */
function manualSchema(constraints: Record<string, TransientValue>, properties: NormalizedProperty[]): NormalizedSchema {
  return {
    name: "manual",
    description: "",
    content: "",
    extends: null,
    cannot_be_extended: false,
    properties,
    constraints,
  } as unknown as NormalizedSchema;
}

function property(name: string, constraints: Record<string, TransientValue> = {}): NormalizedProperty {
  return { name, type: "string", default_value: null, null_value: null, constraints } as NormalizedProperty;
}

describe("uiAccessOf — schema level", () => {
  it("is read_only without a constraint", () => {
    expect(uiAccessOf(schemaOf({ name: "thing", is_root: true, properties: [{ name: "title", type: "string" }] }))).toBe("read_only");
  });

  it.each(["hidden", "read_only", "editable"] as const)("is the stated level %s", (level) => {
    expect(
      uiAccessOf(schemaOf({ name: "thing", is_root: true, ui_access: level, properties: [{ name: "title", type: "string" }] })),
    ).toBe(level);
  });
});

describe("uiAccessOf — property level", () => {
  type Level = UiAccess | undefined;
  const cases: Array<[Level, Level, UiAccess]> = [
    [undefined, undefined, "read_only"],
    ["editable", undefined, "editable"],
    ["editable", "editable", "editable"],
    ["editable", "read_only", "read_only"],
    ["editable", "hidden", "hidden"],
    ["read_only", undefined, "read_only"],
    ["read_only", "editable", "read_only"],
    ["read_only", "hidden", "hidden"],
    [undefined, "editable", "read_only"],
    ["hidden", undefined, "hidden"],
    ["hidden", "editable", "hidden"],
  ];

  it.each(cases)("schema %s, property %s gives %s", (schemaLevel, propertyLevel, expected) => {
    const schema = schemaOf({
      name: "thing",
      is_root: true,
      ...(schemaLevel ? { ui_access: schemaLevel } : {}),
      properties: [{ name: "title", type: "string", ...(propertyLevel ? { ui_access: propertyLevel } : {}) }],
    });
    expect(uiAccessOf(schema, "title")).toBe(expected);
  });
});

describe("uiAccessOf — properties that cannot be updated stay read_only", () => {
  it("a constant property", () => {
    const schema = schemaOf({
      name: "thing",
      is_root: true,
      ui_access: "editable",
      properties: [
        { name: "code", type: "string", constant: true },
        { name: "title", type: "string" },
      ],
    });
    expect(uiAccessOf(schema, "code")).toBe("read_only");
    expect(uiAccessOf(schema, "title")).toBe("editable");
  });

  it("the key of a schema shared by name", () => {
    const schema = schemaOf({
      name: "person",
      shared_by_name: true,
      ui_access: "editable",
      properties: [
        { name: "name", type: "identifier" },
        { name: "email", type: "string" },
      ],
    });
    expect(uiAccessOf(schema, "name")).toBe("read_only");
    expect(uiAccessOf(schema, "email")).toBe("editable");
  });

  it("the key of a plain shared schema", () => {
    const schema = manualSchema({ ui_access: "editable" }, [property("id"), property("title")]);
    expect(uiAccessOf(schema, "id")).toBe("read_only");
    expect(uiAccessOf(schema, "title")).toBe("editable");
  });

  it("every property of a constant schema", () => {
    const schema = schemaOf({
      name: "fact",
      is_root: true,
      constant: true,
      ui_access: "editable",
      properties: [{ name: "label", type: "string" }],
    });
    expect(uiAccessOf(schema, "label")).toBe("read_only");
  });

  it("a generated inverse relation", () => {
    const schema = manualSchema({ ui_access: "editable" }, [
      property("name", {}),
      property("assigned_tasks", { __generated: true }),
    ]);
    expect(uiAccessOf(schema, "assigned_tasks")).toBe("read_only");
  });

  it("a hidden property stays hidden under a cap", () => {
    const schema = schemaOf({
      name: "thing",
      is_root: true,
      ui_access: "editable",
      properties: [{ name: "code", type: "string", constant: true, ui_access: "hidden" }],
    });
    expect(uiAccessOf(schema, "code")).toBe("hidden");
  });
});

describe("uiAccessOf — unknown property", () => {
  it("throws unknown_property", () => {
    const schema = schemaOf({ name: "thing", is_root: true, properties: [{ name: "title", type: "string" }] });
    try {
      uiAccessOf(schema, "nope");
      expect.fail("expected unknown_property");
    } catch (err) {
      expect(err).toBeInstanceOf(ModelError);
      expect((err as ModelError).code).toBe("unknown_property");
    }
  });
});
