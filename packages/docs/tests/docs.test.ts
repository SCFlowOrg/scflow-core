import { describe, expect, it } from "vitest";
import {
  DocsError,
  buildManifest,
  createCatalogue,
  createDocsTool,
  createMemorySource,
  parseManifest,
  parseTopic,
  serializeManifest,
  topicLinks,
  validateTopic,
} from "../src/index.js";

const file = (front: Record<string, string>, body = "Body."): string =>
  `---\n${Object.entries(front)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n")}\n---\n\n${body}\n`;

const base = { title: "Undo", summary: "Undo and redo changes.", kind: "how-to", audience: "user" };

describe("parseTopic", () => {
  it("reads front matter and body, with defaults", () => {
    const { topic, body } = parseTopic(file({ id: "scflow/undo", ...base, context: "[documents.history, a.b]", uses: "['x/y']" }, "Press **Ctrl+Z**."));
    expect(topic).toMatchObject({ id: "scflow/undo", locale: "en", generated: false, context: ["documents.history", "a.b"], uses: ["x/y"] });
    expect(body).toBe("Press **Ctrl+Z**.\n");
  });

  it("reads comments, block lists and CRLF", () => {
    const text = "---\r\nid: a/b # the id\r\ntitle: \"T: x\"\r\nsummary: S\r\nkind: reference\r\naudience: model-dev\r\ngenerated: true\r\ncontext:\r\n  - k1\r\n  - k2\r\n---\r\nText";
    const { topic, body } = parseTopic(text);
    expect(topic).toMatchObject({ title: "T: x", generated: true, context: ["k1", "k2"] });
    expect(body).toBe("Text");
  });

  it.each([
    ["no front matter", "just text"],
    ["a bad id", file({ id: "undo", ...base })],
    ["a bad kind", file({ id: "a/b", ...base, kind: "essay" })],
    ["a bad audience", file({ id: "a/b", ...base, audience: "admin" })],
    ["no summary", file({ id: "a/b", title: "T", kind: "how-to", audience: "user" })],
    ["a bad locale", file({ id: "a/b", ...base, locale: "English" })],
    ["a duplicate key", file({ id: "a/b", ...base }).replace("---\n\n", "id: a/c\n---\n\n")],
  ])("refuses %s", (_name, text) => {
    expect(() => parseTopic(text)).toThrow(DocsError);
  });
});

describe("topicLinks", () => {
  it("lists ids once and skips code", () => {
    const body = "See [[a/b]] and [[a/c|the C]], again [[a/b]].\n`[[no/pe]]`\n```\n[[no/way]]\n```\n";
    expect(topicLinks(body)).toEqual(["a/b", "a/c"]);
  });
});

describe("catalogue", () => {
  const core = createMemorySource("core", [
    file({ id: "core/undo", ...base, context: "[documents.history]", uses: "[scflow/undo]" }, "Undo. See [[core/redo]]."),
    file({ id: "core/undo", ...base, title: "Annuler", locale: "fr" }, "Annuler."),
    file({ id: "core/redo", ...base, title: "Redo", summary: "Redo a change." }, "Redo after an undo."),
    file({ id: "core/api", title: "Plugin API", summary: "The plugin API.", kind: "reference", audience: "plugin-dev" }, "Hooks and events."),
  ]);

  it("filters by audience and falls back to the default locale", async () => {
    const catalogue = await createCatalogue([core]);
    expect(catalogue.topics().map((t) => t.id)).toEqual(["core/api", "core/redo", "core/undo"]);
    expect(catalogue.topics({ audience: "user" }).map((t) => t.id)).toEqual(["core/redo", "core/undo"]);
    expect(catalogue.topics({ audience: ["plugin-dev", "model-dev"] }).map((t) => t.id)).toEqual(["core/api"]);
    expect(catalogue.get("core/undo", "fr")?.title).toBe("Annuler");
    expect(catalogue.get("core/redo", "fr")?.title).toBe("Redo");
    expect(catalogue.topics({ locale: "fr" }).find((t) => t.id === "core/undo")?.locale).toBe("fr");
    expect(await catalogue.read("core/undo", "fr")).toBe("Annuler.\n");
    await expect(catalogue.read("core/missing")).rejects.toMatchObject({ code: "not_found" });
  });

  it("resolves help keys", async () => {
    const catalogue = await createCatalogue([core]);
    expect(catalogue.resolveHelpKey("documents.history")?.id).toBe("core/undo");
    expect(catalogue.resolveHelpKey("documents.history", { audience: "plugin-dev" })).toBeUndefined();
    expect(catalogue.resolveHelpKey("nothing")).toBeUndefined();
  });

  it("searches summaries and bodies, best first", async () => {
    const catalogue = await createCatalogue([core]);
    const hits = await catalogue.search("redo");
    expect(hits[0].topic.id).toBe("core/redo");
    expect((await catalogue.search("hooks"))[0].topic.id).toBe("core/api");
    expect(await catalogue.search("hooks", { audience: "user" })).toEqual([]);
    expect(await catalogue.search("  ")).toEqual([]);
    expect(await catalogue.search("undo", { limit: 1 })).toHaveLength(1);
  });

  it("checks links, duplicates and help keys", async () => {
    const other = createMemorySource("other", [
      file({ id: "core/undo", ...base }, "Duplicate."),
      file({ id: "o/x", ...base, context: "[documents.history]" }, "Links [[core/nope]] and [[core/redo]]."),
    ]);
    const catalogue = await createCatalogue([core, other]);
    const problems = await catalogue.check({ helpKeys: ["documents.history", "ui.missing"] });
    expect(problems.map((p) => p.code).sort()).toEqual(["ambiguous_help_key", "duplicate_id", "unresolved_help_key", "unresolved_link"]);
    expect(problems.find((p) => p.code === "unresolved_link")).toMatchObject({ id: "o/x", link: "core/nope" });
    expect(await (await createCatalogue([core])).check({ helpKeys: ["documents.history"] })).toEqual([]);
  });

  it("reports an unreadable body and refreshes", async () => {
    const topics = [parseTopic(file({ id: "a/b", ...base })).topic];
    let more = false;
    const broken = {
      id: "broken",
      list: async () => (more ? [...topics, parseTopic(file({ id: "a/c", ...base })).topic] : topics),
      read: async () => {
        throw new Error("gone");
      },
    };
    const catalogue = await createCatalogue([broken]);
    expect((await catalogue.check())[0]).toMatchObject({ code: "unreadable_topic", id: "a/b" });
    more = true;
    await catalogue.refresh();
    expect(catalogue.topics()).toHaveLength(2);
  });
});

describe("manifest", () => {
  it("round-trips without bodies", async () => {
    const catalogue = await createCatalogue([createMemorySource("s", [file({ id: "b/b", ...base }), file({ id: "a/a", ...base })])]);
    const text = serializeManifest(buildManifest(catalogue.all(), "s"));
    expect(text).not.toContain("Body.");
    const manifest = parseManifest(text);
    expect(manifest.topics.map((t) => t.id)).toEqual(["a/a", "b/b"]);
    expect(manifest.source).toBe("s");
    expect(() => parseManifest("{}")).toThrow(DocsError);
    expect(() => parseManifest("nope")).toThrow(DocsError);
    expect(() => validateTopic({ id: "a/a" })).toThrow(DocsError);
  });
});

describe("read tool", () => {
  const source = createMemorySource("s", [
    file({ id: "a/user", ...base }, "User text about undo."),
    file({ id: "a/dev", ...base, audience: "plugin-dev", title: "Dev" }, "Dev text about undo."),
  ]);

  it("searches and reads inside the audience only", async () => {
    const tool = createDocsTool(await createCatalogue([source]), { audience: "user" });
    expect(tool?.spec.name).toBe("read_docs");
    const found = await tool!.call({ query: "undo" });
    expect("results" in found && found.results.map((r) => r.id)).toEqual(["a/user"]);
    const read = await tool!.call({ topicId: "a/user" });
    expect("content" in read && read.content).toContain("User text");
    await expect(tool!.call({ topicId: "a/dev" })).rejects.toMatchObject({ code: "not_found" });
    await expect(tool!.call({})).rejects.toMatchObject({ code: "invalid_parameters" });
    await expect(tool!.call({ query: "x", topicId: "a/user" })).rejects.toMatchObject({ code: "invalid_parameters" });
  });

  it("offers nothing for an empty audience", async () => {
    expect(createDocsTool(await createCatalogue([source]), { audience: "model-dev" })).toBeNull();
  });
});
