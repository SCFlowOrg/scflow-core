import { describe, expect, it } from "vitest";
import { load } from "js-yaml";
import { createJsPersistenceInterface } from "@scfloworg/format-js";
import { defineModule } from "@scfloworg/module";
import { DOCS_TOOL, createDocsCatalogue, createDocsTool, createEnvironment } from "../src/index.js";

/** The documentation of an environment, `docs/environment.md`, Documentation. */

const guideYaml = `
name: acme:guide
namespace: guide
version: 1.0.0
mcl: ^1.0
title: Guide
schemas:
  - name: tip
    shared_by_name:
    properties:
      - name: name
        type: identifier
docs:
  - id: guide/tips
    title: Tips
    summary: How to publish a tip.
    kind: how-to
    audience: user
    context: [guide.tips]
    file: docs/tips.md
  - id: guide/tips
    locale: fr
    title: Astuces
    summary: Comment publier une astuce.
    kind: how-to
    audience: user
    file: docs/tips.fr.md
  - id: guide/internals
    title: Internals
    summary: How the guide module is built.
    kind: explanation
    audience: model-dev
    file: docs/internals.md
`;

const guide = () =>
  defineModule(load(guideYaml) as Record<string, unknown>, {
    docs: {
      "docs/tips.md": "Publish a tip. See [[guide/internals]].\n",
      "docs/tips.fr.md": "Publiez une astuce.\n",
      "docs/internals.md": "Built from YAML.\n",
    },
  });

function environment() {
  const env = createEnvironment({ formats: [createJsPersistenceInterface()] });
  env.modules.install(guide());
  return env;
}

describe("env.docs", () => {
  it("lists the topics of the installed modules, without their file", async () => {
    const topics = await environment().docs.list();
    expect(topics.map((t) => [t.id, t.locale, t.audience])).toEqual([
      ["guide/tips", "en", "user"],
      ["guide/tips", "fr", "user"],
      ["guide/internals", "en", "model-dev"],
    ]);
    expect(topics[0]).not.toHaveProperty("file");
    expect(topics[0].context).toEqual(["guide.tips"]);
  });

  it("reads a body in its locale, and fails for an unknown topic", async () => {
    const { docs } = environment();
    expect(await docs.read("guide/tips")).toBe("Publish a tip. See [[guide/internals]].\n");
    expect(await docs.read("guide/tips", "fr")).toBe("Publiez une astuce.\n");
    await expect(docs.read("guide/nope")).rejects.toMatchObject({ code: "not_found" });
  });

  it("gives nothing for a module that is not installed", async () => {
    const env = createEnvironment({ formats: [createJsPersistenceInterface()] });
    expect(await env.docs.list()).toEqual([]);
  });

  it("feeds a catalogue and the read tool, and sees a module installed later after a refresh", async () => {
    const env = createEnvironment({ formats: [createJsPersistenceInterface()] });
    const catalogue = await createDocsCatalogue([env.docs]);
    expect(createDocsTool(catalogue, { audience: "user" })).toBeNull();
    env.modules.install(guide());
    await catalogue.refresh();
    expect(await catalogue.check({ helpKeys: ["guide.tips"] })).toEqual([]);
    expect(catalogue.resolveHelpKey("guide.tips", { audience: "user", locale: "fr" })?.title).toBe("Astuces");
    const tool = createDocsTool(catalogue, { audience: "user" })!;
    expect(tool.spec.name).toBe(DOCS_TOOL);
    expect(await tool.call({ topicId: "guide/tips" })).toMatchObject({ content: expect.stringContaining("Publish a tip") });
    await expect(tool.call({ topicId: "guide/internals" })).rejects.toMatchObject({ code: "not_found" });
  });
});
