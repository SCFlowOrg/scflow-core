import { describe, expect, it } from "vitest";
import * as browser from "../src/browser.js";
import * as main from "../src/index.js";

describe("@scfloworg/environment/browser", () => {
  it("has every runtime export of the main entry, so a browser host reaches the same API", () => {
    expect(Object.keys(browser).sort()).toEqual(Object.keys(main).sort());
  });

  it("gives the skills and documentation tools a browser host needs", () => {
    expect(typeof browser.createSkillTool).toBe("function");
    expect(browser.SKILL_TOOL).toBe(main.SKILL_TOOL);
    expect(typeof browser.createDocsTool).toBe("function");
    expect(browser.MODULE_DOCS_SOURCE).toBe(main.MODULE_DOCS_SOURCE);
  });

  it("makes an environment whose modules.load fails, as there is no file system", async () => {
    const env = browser.createEnvironment({ formats: [] });
    await expect(env.modules.load("packages/carbon")).rejects.toMatchObject({ code: "constraint_violation" });
  });
});
