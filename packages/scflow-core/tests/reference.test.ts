import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";
import { readModuleManifest } from "@scfloworg/core";
import { createCatalogue } from "@scfloworg/docs";
import { createEnvironment } from "@scfloworg/environment";
import { createJsPersistenceInterface } from "@scfloworg/format-js";
import { defineModule, type ModuleBody } from "@scfloworg/module";
import { generateReference } from "@scfloworg/module/reference";
import { ACTION_BODIES } from "../src/actions/index.js";
import { docTexts, SKILL_TEXTS } from "./moduleTexts.js";

/**
 * The reference topics of scflow:core are generated from module.yaml by
 * scripts/build-docs.mjs (run by `build`) and committed. These tests fail when
 * a schema or an action changes without running the build again.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const text = (file: string) => readFileSync(join(root, file), "utf8");
const manifest = readModuleManifest(text("module.yaml"));
const generated = generateReference(manifest);

describe("the reference topics of scflow:core", () => {
  it("are declared in module.yaml exactly as generated", () => {
    for (const { topic } of generated) {
      expect(manifest.docs?.find((entry) => entry.id === topic.id)).toEqual(topic);
    }
  });

  it("have the text of their files: run the build again after a change of a schema or an action", () => {
    for (const { topic, body } of generated) expect(text(topic.file)).toBe(body);
  });

  it("cover every action and every non-abstract schema", () => {
    const [concepts, actions] = generated;
    for (const action of manifest.actions) expect(actions.body).toContain(`### \`${String(action.id)}\``);
    for (const schema of manifest.schemas)
      if (schema.abstract !== true) expect(concepts.body).toContain(`### ${String(schema.name)}\n`);
  });

  it("pass the check of the catalogue of an environment with the module installed", async () => {
    const files: Record<string, string> = {};
    for (const entry of manifest.docs ?? []) files[entry.file] = text(entry.file);
    const env = createEnvironment({ formats: [createJsPersistenceInterface()] });
    env.modules.install(
      defineModule(load(text("module.yaml")) as Record<string, unknown>, {
        actions: ACTION_BODIES as Record<string, ModuleBody>,
        skills: SKILL_TEXTS,
  docs: docTexts(),
        docs: files,
      }),
    );
    const catalogue = await createCatalogue([env.docs]);
    expect(await catalogue.check()).toEqual([]);
    expect(catalogue.topics({ audience: "model-dev" }).map((topic) => topic.id)).toEqual(
      expect.arrayContaining(["scflow/actions", "scflow/action-conventions"]),
    );
    expect(catalogue.topics({ audience: "user" }).map((topic) => topic.id)).toContain("scflow/concepts");
    expect(await catalogue.read("scflow/actions")).toContain("scflow/create_actor");
  });
});
