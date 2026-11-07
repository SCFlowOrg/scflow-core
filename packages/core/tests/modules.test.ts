import { describe, expect, it } from "vitest";
import { createModuleSet, readModuleManifest, resolveType } from "../src/index.js";

const header = (key: string, namespace: string, extra = "") =>
  `name: ${key}\nnamespace: ${namespace}\nversion: 1.0.0\nmcl: ^1.0\n${extra}`;

describe("module set", () => {
  it("processes mutual relations and a relation to the schema itself", () => {
    const set = createModuleSet([
      readModuleManifest(
        header(
          "acme:graph",
          "graph",
          `schemas:
  - name: node
    properties:
      - name: parent
        type: node
      - name: first
        type: edge
  - name: edge
    properties:
      - name: from
        type: node
`,
        ),
      ),
    ]);
    const node = set.module("acme:graph")?.schemas.get("node");
    expect(node?.properties.map((p) => p.type)).toEqual(["graph.node", "graph.edge"]);
    const resolved = resolveType("graph.edge", set.context());
    expect(resolved.kind === "relation" && resolved.schema.name).toBe("edge");
  });

  it("refuses a cycle of extends, within a module and across scalar types", () => {
    expect(() =>
      createModuleSet([
        readModuleManifest(
          header(
            "acme:loop",
            "loop",
            "schemas:\n  - name: a\n    extends: b\n  - name: b\n    extends: a\n",
          ),
        ),
      ]),
    ).toThrow(expect.objectContaining({ code: "extends_cycle" }));
    expect(() =>
      createModuleSet([
        readModuleManifest(
          header(
            "acme:loop",
            "loop",
            "scalar_types:\n  - name: a\n    extends: b\n  - name: b\n    extends: a\n",
          ),
        ),
      ]),
    ).toThrow(expect.objectContaining({ code: "extends_cycle" }));
  });

  it("refuses an extends that does not resolve", () => {
    expect(() =>
      createModuleSet([
        readModuleManifest(header("acme:x", "x", "schemas:\n  - name: a\n    extends: nowhere\n")),
      ]),
    ).toThrow(expect.objectContaining({ code: "unknown_extends_target" }));
  });

  it("resolves the scalar types of a dependency, in map types too", () => {
    const base = readModuleManifest(
      header(
        "acme:base",
        "base",
        "scalar_types:\n  - name: code\n    extends: string\n    pattern: '^[A-Z]{3}$'\n  - name: short_code\n    extends: code\n    max_length: 3\n",
      ),
    );
    const user = readModuleManifest(
      header(
        "acme:user",
        "user",
        `dependencies:
  - module: acme:base
    version: ^1.0
scalar_types:
  - name: plant_code
    extends: base.short_code
schemas:
  - name: plant
    properties:
      - name: code
        type: plant_code
      - name: aliases
        type: "{base.code: string}"
`,
      ),
    );
    const set = createModuleSet([base, user]);
    expect(set.module("acme:user")?.scalarTypes.get("plant_code")?.extends).toBe("base.short_code");
    const resolved = resolveType("user.plant_code", set.context());
    expect(resolved).toMatchObject({
      kind: "scalar",
      base: "string",
      constraints: { pattern: "^[A-Z]{3}$", max_length: 3 },
    });
    const plant = set.module("acme:user")?.schemas.get("plant");
    expect(plant?.properties.map((p) => p.type)).toEqual([
      "user.plant_code",
      "{base.code: string}",
    ]);
    expect(resolveType("{base.code: string}", set.context()).kind).toBe("map");
  });

  it("validates a standard type of mcl:core with its real pattern", () => {
    const set = createModuleSet([]);
    expect(resolveType("module_key", set.context())).toMatchObject({
      kind: "scalar",
      constraints: { pattern: "^[a-z][a-z0-9_-]*:[a-z][a-z0-9_-]*$" },
    });
    expect(resolveType("date", set.context())).toMatchObject({
      constraints: { pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
    });
  });

  it("refuses a module key given twice and a module named mcl:core", () => {
    const one = readModuleManifest(header("acme:one", "one"));
    expect(() => createModuleSet([one, one])).toThrow(
      expect.objectContaining({ code: "duplicate_name" }),
    );
    expect(() => createModuleSet([readModuleManifest(header("mcl:core", "core2"))])).toThrow(
      expect.objectContaining({ code: "duplicate_name" }),
    );
  });

  it("keeps the defaults of an action and refuses a value outside its enum", () => {
    const manifest = readModuleManifest(
      header("acme:a", "a", "actions:\n  - id: a/run\n    destructive:\n"),
    );
    expect(manifest.actions[0]).toMatchObject({
      id: "a/run",
      kind: "action",
      exposure: "visible",
      destructive: true,
    });
    expect(() =>
      readModuleManifest(header("acme:a", "a", "actions:\n  - id: a/run\n    kind: write\n")),
    ).toThrow(expect.objectContaining({ code: "constraint_violation" }));
  });

  it("refuses a primitive name and a text that does not parse", () => {
    expect(() =>
      readModuleManifest(
        header("acme:a", "a", "scalar_types:\n  - name: string\n    extends: string\n"),
      ),
    ).toThrow(expect.objectContaining({ code: "constraint_violation" }));
    expect(() => readModuleManifest("name: [unclosed")).toThrow(
      expect.objectContaining({ code: "constraint_violation" }),
    );
  });
});
