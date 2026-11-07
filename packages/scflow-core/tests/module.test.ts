import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createModuleSet, readModuleManifest } from "@scfloworg/core";
import { ACTIONS, SCHEMAS } from "../src/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = readModuleManifest(readFileSync(join(root, "module.yaml"), "utf8"));
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  version: string;
};

describe("the module scflow:core", () => {
  it("is declared by module.yaml, a valid module manifest", () => {
    expect(manifest).toMatchObject({
      name: "scflow:core",
      namespace: "scflow",
      mcl: "^1.0",
      title: "Supply chain flow",
      dependencies: [],
    });
  });

  it("has the version of the package", () => {
    expect(manifest.version).toBe(packageJson.version);
  });

  it("processes in a module set, every name resolved", () => {
    const set = createModuleSet([manifest]);
    const module = set.module("scflow:core");
    // processed on demand, so in an order of their own
    const sorted = (names: Iterable<unknown>) => [...names].map(String).sort();
    expect(sorted(module?.scalarTypes.keys() ?? [])).toEqual(
      sorted(manifest.scalar_types.map((t) => t.name)),
    );
    expect(sorted(module?.schemas.keys() ?? [])).toEqual(
      sorted(manifest.schemas.map((s) => s.name)),
    );
    expect(set.resolveSchema("scflow.actor")?.key).toBe("scflow.actor");
  });

  it("is the source of SCHEMAS", () => {
    expect(SCHEMAS.scalar_types).toEqual(manifest.scalar_types);
    expect(SCHEMAS.schemas).toEqual(manifest.schemas);
  });

  it("declares every action of ACTIONS, and only those", () => {
    expect(
      manifest.actions.map((a) => ({
        id: a.id,
        title: a.title,
        description: a.description,
        kind: a.kind,
      })),
    ).toEqual(
      ACTIONS.map((a) => ({
        id: a.id,
        title: a.title,
        description: a.description,
        kind: a.kind ?? "action",
      })),
    );
  });
});
