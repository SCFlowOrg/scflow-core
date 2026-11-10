import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { createModuleSet, readModuleManifest } from "@scfloworg/core";
import { buildModule } from "../src/build.js";
import { checkModuleCode } from "../src/code.js";
import { modules } from "../src/host.js";
import { defineModule } from "../src/index.js";

/**
 * The skills of a module package: the body of a skill travels in the bundle,
 * or, for a module with no code, in its file; its file must exist, and the
 * body in the bundle must be its text (Skill in
 * packages/core/docs/spec/meta-model.md, and docs/module-packages.md).
 */

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixture = (name: string) => join(fixtures, name);
const bundleOf = (name: string) => join(fixture(name), "dist", "module.js");
const text = (name: string, file: string) => readFileSync(join(fixture(name), file), "utf8");

afterAll(() => {
  for (const name of ["with-skill", "skill-no-code", "missing-skill-file", "skill-body-drift", "unknown-skill-action"])
    rmSync(join(fixture(name), "dist"), { recursive: true, force: true });
});

describe("the skills of a module package", () => {
  it("builds the body of a skill into the bundle, and loads it from there", async () => {
    await buildModule(fixture("with-skill"));
    expect(readFileSync(bundleOf("with-skill"), "utf8")).toContain("Create each tip with");
    const module = await modules.load(fixture("with-skill"));
    expect([...module.skills.keys()]).toEqual(["tips/write_tips"]);
    expect(await module.skills.get("tips/write_tips")!()).toBe(text("with-skill", "skills/write-tips.md"));
  });

  it("reads the body of a skill of a module with no code from its file", async () => {
    expect((await buildModule(fixture("skill-no-code"))).bundle).toBeNull();
    const module = await modules.load(fixture("skill-no-code"));
    expect(await module.skills.get("plain_tips/write_tips")!()).toBe(text("skill-no-code", "skills/write-tips.md"));
  });

  it("refuses a skill whose file the package does not hold, at build and at load", async () => {
    await expect(buildModule(fixture("missing-skill-file"))).rejects.toMatchObject({
      code: "constraint_violation",
      message: expect.stringContaining("skills/write-tips.md"),
    });
    await expect(modules.load(fixture("missing-skill-file"))).rejects.toMatchObject({ code: "constraint_violation" });
  });

  it("refuses a bundle whose skill body is not the text of its file, and leaves no bundle", async () => {
    await expect(buildModule(fixture("skill-body-drift"))).rejects.toMatchObject({
      code: "constraint_violation",
      message: expect.stringContaining("drift/write_tips"),
    });
    expect(existsSync(bundleOf("skill-body-drift"))).toBe(false);
  });

  it("refuses, in schema processing, a skill that uses an unknown action", async () => {
    const manifest = readModuleManifest(text("unknown-skill-action", "module.yaml"));
    expect(() => createModuleSet([manifest])).toThrow(
      expect.objectContaining({ code: "constraint_violation", message: expect.stringContaining("wrong_tips/publish_tip") }),
    );
  });

  it("checks the code: every declared skill has its body, and no other", () => {
    const manifest = readModuleManifest(text("with-skill", "module.yaml"));
    const actions = { publish_tip: () => undefined };
    const body = text("with-skill", "skills/write-tips.md");
    expect([...checkModuleCode(manifest, { default: defineModule(manifest, { actions, skills: { write_tips: body } }) }).skills]).toEqual([
      ["tips/write_tips", body],
    ]);
    for (const skills of [{}, { write_tips: body, read_tips: body }]) {
      expect(() => checkModuleCode(manifest, { default: defineModule(manifest, { actions, skills }) })).toThrow(
        expect.objectContaining({ code: "constraint_violation" }),
      );
    }
  });
});
