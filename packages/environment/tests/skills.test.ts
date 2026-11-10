import { describe, expect, it } from "vitest";
import { load } from "js-yaml";
import { createJsPersistenceInterface } from "@scfloworg/format-js";
import { defineModule } from "@scfloworg/module";
import { SKILL_TOOL, checkSkillCitations, citedActionIds, createEnvironment, createSkillTool } from "../src/index.js";

/** The skills of an environment, `docs/environment.md`, Skills. */

const tipsYaml = `
name: acme:tips
namespace: tips
version: 1.0.0
mcl: ^1.0
title: Tips
schemas:
  - name: tip
    shared_by_name:
    properties:
      - name: name
        type: identifier
skills:
  - id: tips/write_tips
    title: Write tips
    description: Use when writing tips.
    uses: [tips/create_tip]
    file: skills/write-tips.md
  - id: tips/clean_tips
    title: Clean tips
    description: Use when removing old tips.
    uses: [tips/create_tip, tips/delete_tip]
    file: skills/clean-tips.md
  - id: tips/internal
    title: Internal
    description: For the module's own tools.
    uses: []
    exposure: hidden
    file: skills/internal.md
`;

const bodies = {
  write_tips: "# Write tips\n\nCreate each tip with `tips/create_tip`.\n",
  clean_tips: "# Clean tips\n\nRemove a tip with `tips/delete_tip`, never with `tips/update_tip`.\n",
  internal: "# Internal\n",
};

const tips = () => defineModule(load(tipsYaml) as Record<string, unknown>, { skills: bodies });

function environment() {
  const env = createEnvironment({ formats: [createJsPersistenceInterface()] });
  env.modules.install(tips());
  return env;
}

describe("the skills of an environment", () => {
  it("lists the skills of the installed modules: qualified id, title, description and uses", () => {
    expect(environment().skills.list()).toEqual([
      { id: "tips/write_tips", module: "acme:tips", title: "Write tips", description: "Use when writing tips.", uses: ["tips/create_tip"], exposure: "visible" },
      {
        id: "tips/clean_tips",
        module: "acme:tips",
        title: "Clean tips",
        description: "Use when removing old tips.",
        uses: ["tips/create_tip", "tips/delete_tip"],
        exposure: "visible",
      },
      { id: "tips/internal", module: "acme:tips", title: "Internal", description: "For the module's own tools.", uses: [], exposure: "hidden" },
    ]);
  });

  it("loads a body on demand, as { skillId, title, instructions }", async () => {
    const env = environment();
    expect(await env.skills.load("tips/write_tips")).toEqual({ skillId: "tips/write_tips", title: "Write tips", instructions: bodies.write_tips });
    await expect(env.skills.load("tips/unknown")).rejects.toMatchObject({ code: "key_not_found" });
  });

  it("never lists the skills of a module that comes only embedded in a dataset", async () => {
    const dump = await (await environment().datasets.create({ locator: "js:tips", modules: ["acme:tips"] })).dump("json");
    const other = createEnvironment({ formats: [createJsPersistenceInterface()] });
    const dataset = await other.datasets.restore("js:tips", dump, "json", { readOnly: true });
    expect(dataset.modules).toMatchObject([{ module: "acme:tips", state: "missing" }]);
    expect(other.skills.list()).toEqual([]);
    await expect(other.skills.load("tips/write_tips")).rejects.toMatchObject({ code: "key_not_found" });
  });

  it("builds use_skill offering a visible skill only with every action of its uses", async () => {
    const env = environment();
    const tool = createSkillTool(env.skills, { actions: ["tips/create_tip"] })!;
    expect(tool.skills.map((skill) => skill.id)).toEqual(["tips/write_tips"]);
    expect(tool.spec).toMatchObject({
      name: SKILL_TOOL,
      inputSchema: {
        type: "object",
        properties: { skillId: { type: "string", enum: ["tips/write_tips"] } },
        required: ["skillId"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
    });
    expect(tool.spec.description).toContain("tips/write_tips: Write tips. Use when writing tips.");
    expect(await tool.call({ skillId: "tips/write_tips" })).toEqual({ skillId: "tips/write_tips", title: "Write tips", instructions: bodies.write_tips });
    // a skill that needs an action the assistant does not offer is not offered
    await expect(tool.call({ skillId: "tips/clean_tips" })).rejects.toMatchObject({ code: "invalid_parameters" });
    await expect(tool.call({})).rejects.toMatchObject({ code: "invalid_parameters" });

    const all = createSkillTool(env.skills, { actions: (id) => id.startsWith("tips/") })!;
    expect(all.skills.map((skill) => skill.id)).toEqual(["tips/write_tips", "tips/clean_tips"]);
    expect(createSkillTool(env.skills, { actions: [] })).toBeNull();
  });

  it("finds the action ids a body cites, and those its uses does not name", async () => {
    expect(citedActionIds("Use `tips/create_tip`, then `tips/create_tip` or `describe_model`, `a/b c` and tips/delete_tip.")).toEqual([
      "tips/create_tip",
    ]);
    const env = environment();
    expect(await checkSkillCitations(env.skills, ["tips/write_tips"])).toEqual([]);
    expect(await checkSkillCitations(env.skills)).toEqual([{ skill: "tips/clean_tips", action: "tips/update_tip" }]);
  });
});
