import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson, buildDatasetModel } from "../src/datasetModules.js";
import { isLocalModule, moduleDigest, readModuleManifest } from "../src/index.js";

const manifest = readModuleManifest(`
name: acme:tasks
namespace: tasks
version: 1.0.0
mcl: ^1.0
schemas:
  - name: person
    shared_by_name:
    properties:
      - name: name
        type: identifier
  - name: task
    properties:
      - name: assignee
        type: person
        inverse_name: tasks
        inverse_is_array:
  - name: urgent_task
    extends: task
    properties:
      - name: level
        type: integer
`);

describe("module digest", () => {
  it("writes JSON with sorted keys and no white space", () => {
    expect(canonicalJson({ b: [1, { d: null, c: "x" }], a: true, skipped: undefined })).toBe('{"a":true,"b":[1,{"c":"x","d":null}]}');
  });

  it("is sha256: and the hex SHA-256 of the canonical manifest", async () => {
    const expected = createHash("sha256").update(canonicalJson(manifest), "utf8").digest("hex");
    expect(await moduleDigest(manifest)).toBe(`sha256:${expected}`);
  });

  it("tells a local module by its publisher", () => {
    expect(isLocalModule("local:tasks")).toBe(true);
    expect(isLocalModule("acme:tasks")).toBe(false);
  });
});

describe("model of a dataset", () => {
  it("names each schema by its qualified name and generates inverse relations once", () => {
    const model = buildDatasetModel([manifest]);
    expect([...model.schemas.keys()]).toEqual(["tasks.person", "tasks.task", "tasks.urgent_task"]);
    expect(model.schemas.get("tasks.task")?.name).toBe("tasks.task");
    const inverse = model.schemas.get("tasks.person")?.properties.filter((p) => p.name === "tasks");
    // the relation inherited by urgent_task generates no second inverse: it names the declaring schema
    expect(inverse).toEqual([expect.objectContaining({ type: "tasks.task", constraints: expect.objectContaining({ __generated: true, is_array: true }) })]);
    // the standard types of mcl:core are there by short name
    expect(model.scalarTypes.get("date")?.constraints.pattern).toBeTruthy();
  });
});
