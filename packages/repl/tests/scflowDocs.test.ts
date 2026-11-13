import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runScflow } from "../src/scflow.js";

const header = `
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
`;

const topics = `  - id: guide/tips
    title: Tips
    summary: How to publish a tip.
    kind: how-to
    audience: user
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

const temporary: string[] = [];
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function modules(tipsBody = "Publish a tip. See [[guide/internals]].\n") {
  const root = mkdtempSync(join(tmpdir(), "scflow-docs-"));
  temporary.push(root);
  const folder = join(root, "modules");
  mkdirSync(join(folder, "guide", "docs"), { recursive: true });
  writeFileSync(join(folder, "guide", "module.yaml"), header + topics);
  writeFileSync(join(folder, "guide", "docs", "tips.md"), tipsBody);
  writeFileSync(join(folder, "guide", "docs", "tips.fr.md"), "Publiez une astuce.\n");
  writeFileSync(join(folder, "guide", "docs", "internals.md"), "Built from YAML.\n");
  return { root, folder };
}

async function scflow(args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  async function* lines(): AsyncGenerator<string> {}
  const code = await runScflow(args, { out: (l) => out.push(l), err: (l) => err.push(l), lines: lines() });
  return { code, out: out.map((l) => JSON.parse(l) as any), err };
}

describe("scflow docs list", () => {
  it("lists the topics in the default locale, ordered by id", async () => {
    const { folder } = modules();
    const { code, out } = await scflow(["docs", "list", "--modules", folder]);
    expect(code).toBe(0);
    expect(out[0].map((t: { id: string; locale: string }) => [t.id, t.locale])).toEqual([
      ["guide/internals", "en"],
      ["guide/tips", "en"],
    ]);
  });

  it("filters by audience and locale", async () => {
    const { folder } = modules();
    const user = await scflow(["docs", "list", "--audience", "user", "--locale", "fr", "--modules", folder]);
    expect(user.out[0].map((t: { id: string; locale: string }) => [t.id, t.locale])).toEqual([["guide/tips", "fr"]]);
    const dev = await scflow(["docs", "list", "--audience", "model-dev", "--modules", folder]);
    expect(dev.out[0].map((t: { id: string }) => t.id)).toEqual(["guide/internals"]);
  });

  it("refuses an unknown audience as a wrong command line", async () => {
    const { folder } = modules();
    const { code, err } = await scflow(["docs", "list", "--audience", "nobody", "--modules", folder]);
    expect(code).toBe(2);
    expect(err[0]).toContain("--audience");
  });
});

describe("scflow docs show", () => {
  it("gives a topic and its body, in the locale asked", async () => {
    const { folder } = modules();
    const en = await scflow(["docs", "show", "guide/tips", "--modules", folder]);
    expect(en.out[0].topic.title).toBe("Tips");
    expect(en.out[0].content).toContain("Publish a tip");
    const fr = await scflow(["docs", "show", "guide/tips", "--locale", "fr", "--modules", folder]);
    expect(fr.out[0].content).toBe("Publiez une astuce.\n");
  });

  it("refuses an unknown topic, and one outside the audience", async () => {
    const { folder } = modules();
    const unknown = await scflow(["docs", "show", "guide/none", "--modules", folder]);
    expect(unknown.code).toBe(1);
    expect(JSON.parse(unknown.err[0] as string).error.code).toBe("not_found");
    const hidden = await scflow(["docs", "show", "guide/internals", "--audience", "user", "--modules", folder]);
    expect(hidden.code).toBe(1);
  });

  it("needs an id", async () => {
    const { folder } = modules();
    expect((await scflow(["docs", "show", "--modules", folder])).code).toBe(2);
  });
});

describe("scflow docs check", () => {
  it("exits 0 for a sound catalogue", async () => {
    const { folder } = modules();
    const { code, out } = await scflow(["docs", "check", "--modules", folder]);
    expect(code).toBe(0);
    expect(out[0]).toMatchObject({ ok: true, problems: [] });
  });

  it("exits 1 and names the topic that owns each problem", async () => {
    const { folder } = modules("See [[guide/missing]].\n");
    const { code, out, err } = await scflow(["docs", "check", "--modules", folder]);
    expect(code).toBe(1);
    expect(out[0].ok).toBe(false);
    expect(out[0].problems[0]).toMatchObject({ code: "unresolved_link", id: "guide/tips", link: "guide/missing" });
    expect(err[0]).toMatch(/^guide\/tips: /);
  });
});

describe("scflow docs build", () => {
  it("writes the manifest and the bodies of every locale", async () => {
    const { folder, root } = modules();
    const dir = join(root, "site");
    const { code, out } = await scflow(["docs", "build", dir, "--modules", folder]);
    expect(code).toBe(0);
    expect(out[0].topics).toBe(3);
    const manifest = JSON.parse(readFileSync(join(dir, "docs-manifest.json"), "utf8"));
    expect(manifest.version).toBe(1);
    expect(manifest.source).toBe("modules");
    expect(manifest.topics.map((t: { id: string; locale: string }) => `${t.id}/${t.locale}`)).toEqual([
      "guide/internals/en",
      "guide/tips/en",
      "guide/tips/fr",
    ]);
    expect(readFileSync(join(dir, "en", "guide", "tips.md"), "utf8")).toContain("Publish a tip");
    expect(readFileSync(join(dir, "fr", "guide", "tips.md"), "utf8")).toBe("Publiez une astuce.\n");
  });

  it("keeps only the audiences asked", async () => {
    const { folder, root } = modules();
    const dir = join(root, "user-site");
    await scflow(["docs", "build", dir, "--audience", "user", "--modules", folder]);
    expect(existsSync(join(dir, "en", "guide", "internals.md"))).toBe(false);
    const manifest = JSON.parse(readFileSync(join(dir, "docs-manifest.json"), "utf8"));
    expect(manifest.topics).toHaveLength(2);
  });

  it("needs a directory", async () => {
    const { folder } = modules();
    expect((await scflow(["docs", "build", "--modules", folder])).code).toBe(2);
  });
});
