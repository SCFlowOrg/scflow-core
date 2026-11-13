import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageJson = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"));

describe("the exports of the package", () => {
  it("expose the bundle of the module and its declaration as ./module", () => {
    // The convention of docs/module-packages.md in @scfloworg/module (Build the
    // bundle): a host that bundles its modules imports the module from here.
    expect(packageJson.exports["./module"]).toEqual({
      types: "./dist/module.d.ts",
      default: "./dist/module.js",
    });
  });

  it("ship the files the ./module export names", () => {
    expect(packageJson.files).toContain("dist");
  });
});
