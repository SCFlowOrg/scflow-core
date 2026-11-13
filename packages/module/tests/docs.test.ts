import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { createModuleSet, readModuleManifest } from "@scfloworg/core";
import { buildModule } from "../src/build.js";
import { checkModuleCode } from "../src/code.js";
import { modules } from "../src/host.js";
import { defineModule } from "../src/index.js";

/**
 * The documentation topics of a module package: the body of a topic travels in
 * the bundle, keyed by its file, or, for a module with no code, in its file
 * (Topic in packages/core/docs/spec/meta-model.md, and docs/module-packages.md).
 */

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixture = (name: string) => join(fixtures, name);
const bundleOf = (name: string) => join(fixture(name), "dist", "module.js");
const text = (name: string, file: string) => readFileSync(join(fixture(name), file), "utf8");

afterAll(() => {
  for (const name of ["with-docs", "docs-no-code", "missing-doc-file", "unknown-doc-action"])
    rmSync(join(fixture(name), "dist"), { recursive: true, force: true });
});

describe("the documentation topics of a module package", () => {
  it("validates the topics of a manifest, with their defaults", () => {
    const manifest = readModuleManifest(text("with-docs", "module.yaml"));
    expect(manifest.docs).toHaveLength(2);
    expect(manifest.docs?.[0]).toMatchObject({ id: "guide/tips", locale: "en", generated: false, context: ["guide.tips"] });
    expect(manifest.docs?.[1]).toMatchObject({ locale: "fr", context: [], uses: [] });
    expect(readModuleManifest(text("with-docs", "module.yaml").replace(/docs:[\s\S]*/, "")).docs).toBeUndefined();
  });

  it.each([
    ["an id outside the namespace", "id: guide/tips", "id: other/tips", "constraint_violation"],
    ["a kind outside its enum", "kind: how-to\n    audience: user\n    context", "kind: essay\n    audience: user\n    context", "constraint_violation"],
    ["a file that is not a .md path", "file: docs/tips.md", "file: ../tips.txt", "constraint_violation"],
    ["a uses that is not an action id", "uses: [guide/publish_tip]", "uses: [publish_tip]", "constraint_violation"],
    ["a locale that is not a language tag", "locale: fr", "locale: French", "constraint_violation"],
  ])("refuses %s", (_name, from, to, code) => {
    expect(() => readModuleManifest(text("with-docs", "module.yaml").replace(from, to))).toThrow(expect.objectContaining({ code }));
  });

  it("refuses one topic and locale declared twice", () => {
    const source = text("with-docs", "module.yaml").replace("    locale: fr\n", "");
    expect(() => readModuleManifest(source)).toThrow(expect.objectContaining({ code: "duplicate_name" }));
  });

  it("builds the bodies into the bundle, keyed by file, and loads them from there", async () => {
    await buildModule(fixture("with-docs"));
    expect(readFileSync(bundleOf("with-docs"), "utf8")).toContain("Publiez une astuce");
    const module = await modules.load(fixture("with-docs"));
    expect([...module.docs.keys()]).toEqual(["docs/tips.md", "docs/tips.fr.md"]);
    expect(await module.docs.get("docs/tips.fr.md")!()).toBe(text("with-docs", "docs/tips.fr.md"));
  });

  it("reads the body of a module with no code from its file", async () => {
    expect((await buildModule(fixture("docs-no-code"))).bundle).toBeNull();
    const module = await modules.load(fixture("docs-no-code"));
    expect(await module.docs.get("docs/intro.md")!()).toBe(text("docs-no-code", "docs/intro.md"));
  });

  it("refuses a topic whose file the package does not hold, at build and at load", async () => {
    await expect(buildModule(fixture("missing-doc-file"))).rejects.toMatchObject({
      code: "constraint_violation",
      message: expect.stringContaining("docs/intro.md"),
    });
    await expect(modules.load(fixture("missing-doc-file"))).rejects.toMatchObject({ code: "constraint_violation" });
  });

  it("refuses, in schema processing, a topic that uses an unknown action", () => {
    const manifest = readModuleManifest(text("unknown-doc-action", "module.yaml"));
    expect(() => createModuleSet([manifest])).toThrow(
      expect.objectContaining({ code: "constraint_violation", message: expect.stringContaining("topic \"wrong/intro\" uses \"wrong/publish_tip\"") }),
    );
  });

  it("accepts a topic that uses an action of the module", () => {
    expect(() => createModuleSet([readModuleManifest(text("with-docs", "module.yaml"))])).not.toThrow();
  });

  it("checks the code: every topic file has its body, and no other", () => {
    const manifest = readModuleManifest(text("with-docs", "module.yaml"));
    const actions = { publish_tip: () => undefined };
    const docs = { "docs/tips.md": "en", "docs/tips.fr.md": "fr" };
    expect([...checkModuleCode(manifest, { default: defineModule(manifest, { actions, docs }) }).docs]).toEqual([
      ["docs/tips.md", "en"],
      ["docs/tips.fr.md", "fr"],
    ]);
    for (const bad of [{}, { "docs/tips.md": "en" }, { ...docs, "docs/other.md": "x" }]) {
      expect(() => checkModuleCode(manifest, { default: defineModule(manifest, { actions, docs: bad }) })).toThrow(
        expect.objectContaining({ code: "constraint_violation" }),
      );
    }
  });
});
