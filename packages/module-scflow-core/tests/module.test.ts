import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createModuleSet, readModuleManifest } from "@scfloworg/core";
import { ACTIONS, SCHEMAS } from "../src/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = readModuleManifest(readFileSync(join(root, "module.yaml"), "utf8"));
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  name: string;
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

  it("names its package after its key, as module-<publisher>-<name>", () => {
    const [publisher, name] = manifest.name.split(":");
    expect(packageJson.name).toBe(`@scfloworg/module-${publisher}-${name}`);
    expect(basename(root)).toBe(`module-${publisher}-${name}`);
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
        destructive: a.destructive ?? false,
        writes: a.writes ?? [],
        parameters: a.parameters,
      })),
    ).toEqual(
      ACTIONS.map((a) => ({
        id: a.id,
        title: a.title,
        description: a.description,
        kind: a.kind ?? "action",
        destructive: a.destructive ?? false,
        writes: a.writes,
        parameters: a.parameters,
      })),
    );
  });

  it("writes nothing from a read action and names only its own schemas", () => {
    const names = new Set(manifest.schemas.map((s) => s.name));
    for (const action of ACTIONS) {
      if (action.kind === "read") expect(action.writes, action.id).toEqual([]);
      else expect(action.writes.length, action.id).toBeGreaterThan(0);
      for (const name of action.writes) expect(names.has(name), `${action.id}: ${name}`).toBe(true);
    }
  });

  it("names schemas by their qualified name in the bodies, and by a schema in every ref", () => {
    const refs = (value: unknown): string[] =>
      Array.isArray(value)
        ? value.flatMap(refs)
        : value !== null && typeof value === "object"
          ? Object.entries(value).flatMap(([key, inner]) =>
              key === "ref" && typeof inner === "string" ? [inner] : refs(inner),
            )
          : [];
    const names = new Set(manifest.schemas.map((s) => s.name));
    for (const action of ACTIONS)
      for (const ref of refs(action.parameters)) expect(names.has(ref), `${action.id}: ${ref}`).toBe(true);
  });

  describe("crud", () => {
    type Schema = { name: string; extends?: string; crud?: Record<string, string>; properties: { name: string }[] };
    const schemas = manifest.schemas as unknown as Schema[];
    const propertiesOf = (schema: Schema): string[] => [
      ...schema.properties.map((p) => p.name),
      ...(schema.extends ? propertiesOf(schemas.find((s) => s.name === schema.extends) as Schema) : []),
    ];
    const parametersOf = (id: string) =>
      Object.keys((ACTIONS.find((a) => a.id === id) as (typeof ACTIONS)[number]).parameters.properties);

    it("names the action that takes the place of each declared CRUD operation", () => {
      const ids = new Set(ACTIONS.map((a) => a.id));
      for (const action of ACTIONS) {
        const match = /^scflow\/(create|update|delete)_(.+)$/.exec(action.id);
        const schema = match && schemas.find((s) => s.name === match[2]);
        if (schema) expect(schema.crud?.[(match as string[])[1]], action.id).toBe(action.id);
      }
      for (const schema of schemas)
        for (const id of Object.values(schema.crud ?? {})) expect(ids.has(id), id).toBe(true);
      expect(schemas.find((s) => s.name === "note")?.crud).toEqual({
        create: "scflow/add_note",
        update: "scflow/update_note",
        delete: "scflow/remove_note",
      });
      expect(schemas.find((s) => s.name === "item_at_actor")?.crud).toEqual({
        create: "scflow/hold_item",
        delete: "scflow/release_held_item",
      });
    });

    it("follows the CRUD parameters in those actions", () => {
      for (const schema of schemas) {
        const { create, update, delete: remove } = schema.crud ?? {};
        const properties = propertiesOf(schema);
        if (create) expect(parametersOf(create).sort(), create).toEqual([...properties].sort());
        if (update) {
          const [first, ...rest] = parametersOf(update);
          expect(first, update).toBe("id");
          for (const name of rest) expect(properties, `${update}: ${name}`).toContain(name);
        }
        if (remove) expect(parametersOf(remove), remove).toEqual(["id", "cascade"]);
      }
    });

    it("declares the item of a flow as updated by scflow/set_flow_item", () => {
      const flow = schemas.find((s) => s.name === "flow") as unknown as {
        properties: { name: string; updated_by?: string }[];
      };
      expect(flow.properties.find((p) => p.name === "item")?.updated_by).toBe("scflow/set_flow_item");
    });

    it("generates no action for the abstract base annotable", () => {
      expect(schemas.find((s) => s.name === "annotable")).toMatchObject({ abstract: true });
    });
  });
});
