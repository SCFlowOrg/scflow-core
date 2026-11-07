import { describe, expect, it } from "vitest";
import { checkBundle } from "../src/build.js";

const rules = (code: string) => checkBundle(code).map((finding) => finding.rule);

describe("checkBundle", () => {
  it("passes a bundle with only a default export and allowed globals", () => {
    const code = `
      const freeze = Object.freeze;
      function body(mcl, params) {
        const list = Array.from(new Set(params.tags ?? []));
        return mcl.runCommand({ kind: "create", input: { tags: list, n: Math.max(1, list.length) } });
      }
      class Box { constructor(v) { this.v = v; } }
      const module_default = freeze({ manifest: JSON.parse("{}"), actions: { body }, migrations: {}, Box });
      export { module_default as default };
    `;
    expect(checkBundle(code)).toEqual([]);
  });

  it("passes a default export declaration", () => {
    expect(checkBundle("export default { manifest: {} };")).toEqual([]);
  });

  it("refuses imports, dynamic imports and import.meta", () => {
    expect(rules(`import x from "y"; export default x;`)).toEqual(["import"]);
    expect(rules(`export * from "y"; export default 1;`)).toEqual(["import"]);
    expect(rules(`export default () => import("y");`)).toEqual(["dynamic_import"]);
    expect(rules(`export default import.meta.url;`)).toEqual(["import_meta"]);
  });

  it("refuses an export other than the default one", () => {
    expect(rules(`export const a = 1; export default a;`)).toEqual(["export"]);
    expect(rules(`const a = 1; export { a, a as default };`)).toEqual(["export"]);
  });

  it("refuses a bundle with no default export", () => {
    expect(rules(`const a = 1;`)).toEqual(["no_default_export"]);
  });

  it("refuses eval and Function", () => {
    expect(rules(`export default () => eval("1");`)).toEqual(["forbidden_global"]);
    expect(rules(`export default new Function("return 1");`)).toEqual(["forbidden_global"]);
  });

  it("refuses the globals that read the host", () => {
    for (const name of ["Date", "globalThis", "console", "Intl", "setTimeout", "fetch", "process", "crypto"]) {
      const findings = checkBundle(`export default () => ${name};`);
      expect(findings.map((f) => f.rule)).toEqual(["global"]);
      expect(findings[0].message).toContain(name);
    }
  });

  it("refuses Math.random, in either form", () => {
    expect(rules(`export default () => Math.random();`)).toEqual(["random"]);
    expect(rules(`export default () => Math["random"]();`)).toEqual(["random"]);
  });

  it("does not take a declared or a property name for a global", () => {
    const code = `
      const Date = 1;
      const o = { console: 2, fetch() { return 3; } };
      try { o.fetch(); } catch (process) { void process; }
      export default [Date, o.console, ({ setTimeout }) => setTimeout];
    `;
    expect(checkBundle(code)).toEqual([]);
  });

  it("gives the line of a breach", () => {
    const [finding] = checkBundle(`const a = 1;\nexport default Date.now();`);
    expect(finding).toMatchObject({ rule: "global", line: 2 });
  });
});
