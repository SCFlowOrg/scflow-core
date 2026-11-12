import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";
import { createModuleSet, generatedActionIds, readModuleManifest } from "@scfloworg/core";
import { checkSkillCitations, createEnvironment, createSkillTool, SKILL_TOOL } from "@scfloworg/environment";
import { createJsPersistenceInterface } from "@scfloworg/format-js";
import { defineModule, type ModuleBody } from "@scfloworg/module";
import { ACTION_BODIES } from "../src/actions/index.js";

/**
 * The skills of scflow:core (Skill in packages/core/docs/spec/meta-model.md):
 * each is declared in module.yaml, its body is its file, and every action id
 * the body cites is in its `uses`.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const text = (file: string) => readFileSync(join(root, file), "utf8");
const manifest = readModuleManifest(text("module.yaml"));

/** An environment with scflow:core installed as src/module.ts defines it, bodies of skills included. */
function environment() {
  const env = createEnvironment({ formats: [createJsPersistenceInterface()] });
  env.modules.install(
    defineModule(load(text("module.yaml")) as Record<string, unknown>, {
      actions: ACTION_BODIES as Record<string, ModuleBody>,
      skills: {
        image_to_model: text("skills/image-to-model.md"),
        physical_to_information_flows: text("skills/physical-to-information-flows.md"),
      },
    }),
  );
  return env;
}

describe("the skills of scflow:core", () => {
  const ids = ["scflow/image_to_model", "scflow/physical_to_information_flows"];

  it("declares its skills, whose uses are actions of the module", () => {
    expect(manifest.skills?.map((skill) => skill.id)).toEqual(ids);
    expect(() => createModuleSet([manifest])).not.toThrow();
  });

  it("cites in each body only the actions of its uses", async () => {
    const env = environment();
    expect(env.skills.list().map((skill) => skill.id)).toEqual(ids);
    expect(await checkSkillCitations(env.skills)).toEqual([]);
  });

  it("loads a body on demand, as use_skill gives it", async () => {
    const env = environment();
    expect(await env.skills.load("scflow/image_to_model")).toEqual({
      skillId: "scflow/image_to_model",
      title: "Image to model",
      instructions: text("skills/image-to-model.md"),
    });
    expect(await env.skills.load("scflow/physical_to_information_flows")).toEqual({
      skillId: "scflow/physical_to_information_flows",
      title: "Physical to information flows",
      instructions: text("skills/physical-to-information-flows.md"),
    });
  });

  it("is offered by use_skill only with every action of its uses", async () => {
    const env = environment();
    const actions = manifest.actions.map((action) => action.id as string);
    const tool = createSkillTool(env.skills, { actions });
    expect(tool?.spec).toMatchObject({ name: SKILL_TOOL, inputSchema: { required: ["skillId"] } });
    expect((await tool!.call({ skillId: "scflow/image_to_model" })).title).toBe("Image to model");
    expect(createSkillTool(env.skills, { actions: actions.filter((id) => id !== "scflow/create_flow") })).toBeNull();
  });

  it("knows the actions a skill may use, declared or generated, as a dataset offers them", async () => {
    const dataset = await environment().datasets.create({ modules: ["scflow:core"] });
    const module = createModuleSet([manifest]).module("scflow:core")!;
    const reachable = new Set([...module.actions.keys(), ...generatedActionIds(module)]);
    expect([...reachable].sort()).toEqual(dataset.actions().map((action) => action.id).sort());
  });
});
