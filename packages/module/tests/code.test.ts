import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readModuleManifest } from "@scfloworg/core";
import { checkModuleCode } from "../src/code.js";
import { checkModuleCode as fromHost } from "../src/host.js";
import { defineModule } from "../src/index.js";

const manifest = readModuleManifest(`
name: acme:greet
namespace: greet
version: 1.0.0
mcl: ^1.0
actions:
  - id: greet/say_hello
    title: Say hello
`);

describe("checkModuleCode", () => {
  it("gives the bodies of a defineModule result by action id", () => {
    const body = () => "hello";
    const { actions, migrations } = checkModuleCode(manifest, {
      default: defineModule(manifest, { actions: { say_hello: body } }),
    });
    expect([...actions]).toEqual([["greet/say_hello", body]]);
    expect(migrations.size).toBe(0);
  });

  it("refuses code that does not match the manifest", () => {
    const extra = defineModule(manifest, { actions: { say_hello: () => 1, say_bye: () => 2 } });
    expect(() => checkModuleCode(manifest, { default: extra })).toThrow(
      expect.objectContaining({ code: "constraint_violation" }),
    );
    expect(() => checkModuleCode(manifest, null)).toThrow(
      expect.objectContaining({ code: "constraint_violation" }),
    );
  });

  it("is the check of the host, from an entry that reads no file", () => {
    expect(fromHost).toBe(checkModuleCode);
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "src", "code.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/from "node:/);
  });
});
