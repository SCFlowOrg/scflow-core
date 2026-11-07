import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { buildModule, checkBundle } from "@scfloworg/module/build";
import { modules, type ModulePackage } from "@scfloworg/module/host";
import { ACTIONS } from "../src/index.js";
import { setupActions } from "./actions-helpers.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("the bundle of scflow:core", () => {
  let module: ModulePackage;
  let code: string;

  beforeAll(async () => {
    const { bundle } = await buildModule(root);
    expect(bundle).toBe(join(root, "dist", "module.js"));
    code = readFileSync(bundle!, "utf8");
    module = await modules.load(root);
  }, 60000);

  it("is one ES module that passes the bundle check", () => {
    expect(checkBundle(code)).toEqual([]);
  });

  it("holds no copy of the engine", () => {
    for (const name of ["createModuleSet", "validateModuleManifest", "ModelError", "unknown_persistent_format"])
      expect(code).not.toContain(name);
  });

  it("loads with its manifest and a body for every declared action", () => {
    expect(module.manifest).toMatchObject({ name: "scflow:core", namespace: "scflow" });
    expect(module.bundle).toBe(join(root, "dist", "module.js"));
    expect([...module.actions.keys()].sort()).toEqual(ACTIONS.map((action) => action.id).sort());
    expect(module.migrations.size).toBe(0);
  });

  it("runs a body on the one engine the host gives", async () => {
    const doc = await setupActions();
    const createActorType = module.actions.get("scflow/create_actor_type")!;
    const created = (await createActorType(doc.mcl, doc.locator, {
      name: "Plant",
      domains: ["physical"],
    })) as { id: string };
    const [stored] = await doc.query("actor_type");
    expect(stored.id).toBe(created.id);
    expect(stored.display_name).toEqual({ en: "Plant" });
  });
});
