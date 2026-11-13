import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { buildModule } from "../src/build.js";
import { modules } from "../src/host.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixture = (name: string) => join(fixtures, name);
const bundleOf = (name: string) => join(fixture(name), "dist", "module.js");
const declarationOf = (name: string) => join(fixture(name), "dist", "module.d.ts");

afterAll(() => {
  for (const name of ["with-code", "no-code", "uses-clock", "imports-module", "imports-engine", "undeclared-action"])
    rmSync(join(fixture(name), "dist"), { recursive: true, force: true });
});

describe("buildModule", () => {
  it("builds a module with code to one ES module with the manifest inlined", async () => {
    const result = await buildModule(fixture("with-code"));
    expect(result.bundle).toBe(bundleOf("with-code"));
    const code = readFileSync(bundleOf("with-code"), "utf8");
    expect(code).toContain("acme:greet");
    expect(code).toContain("Hello, ");
    expect(code).not.toMatch(/^\s*import\s/m);
    const url = pathToFileURL(bundleOf("with-code"));
    url.search = "t=build";
    const { default: module } = await import(/* @vite-ignore */ url.href);
    expect(module.manifest.name).toBe("acme:greet");
    expect(Object.keys(module.actions)).toEqual(["say_hello"]);
  });

  it("writes the declaration of the bundle: its default export is a ModuleDefinition", async () => {
    const result = await buildModule(fixture("with-code"));
    expect(result.declaration).toBe(declarationOf("with-code"));
    expect(readFileSync(declarationOf("with-code"), "utf8")).toBe(
      'import type { ModuleDefinition } from "@scfloworg/module";\n' +
        "declare const definition: ModuleDefinition;\n" +
        "export default definition;\n",
    );
  });

  it("writes no bundle and no declaration for a module with no code, and removes stale ones", async () => {
    mkdirSync(join(fixture("no-code"), "dist"), { recursive: true });
    writeFileSync(bundleOf("no-code"), "export default 1;\n");
    writeFileSync(declarationOf("no-code"), "export default 1;\n");
    const result = await buildModule(fixture("no-code"));
    expect(result.bundle).toBeNull();
    expect(result.declaration).toBeNull();
    expect(existsSync(bundleOf("no-code"))).toBe(false);
    expect(existsSync(declarationOf("no-code"))).toBe(false);
  });

  it("refuses a bundle that uses a global of the host, and writes neither bundle nor declaration", async () => {
    mkdirSync(join(fixture("uses-clock"), "dist"), { recursive: true });
    writeFileSync(declarationOf("uses-clock"), "stale\n");
    await expect(buildModule(fixture("uses-clock"))).rejects.toMatchObject({
      code: "constraint_violation",
      message: expect.stringContaining("Date"),
    });
    expect(existsSync(bundleOf("uses-clock"))).toBe(false);
    expect(existsSync(declarationOf("uses-clock"))).toBe(false);
  });

  it("keeps the engine out of the bundle: a value import of @scfloworg/core is refused", async () => {
    await expect(buildModule(fixture("imports-engine"))).rejects.toMatchObject({
      code: "constraint_violation",
      message: expect.stringContaining("@scfloworg/core"),
    });
  });

  it("refuses a bundle that imports a file of another module package", async () => {
    await expect(buildModule(fixture("imports-module"))).rejects.toMatchObject({
      code: "constraint_violation",
      message: expect.stringContaining("import"),
    });
    expect(existsSync(bundleOf("imports-module"))).toBe(false);
  });

  it("refuses code with no declaration, and leaves no bundle", async () => {
    await expect(buildModule(fixture("undeclared-action"))).rejects.toMatchObject({
      code: "constraint_violation",
      message: expect.stringContaining("plain/not_declared"),
    });
    expect(existsSync(bundleOf("undeclared-action"))).toBe(false);
  });
});

describe("modules.load", () => {
  it("loads a module with no code from its manifest only", async () => {
    rmSync(join(fixture("no-code"), "dist"), { recursive: true, force: true });
    const module = await modules.load(fixture("no-code"));
    expect(module.manifest).toMatchObject({ name: "acme:plain", namespace: "plain", version: "1.0.0" });
    expect(module.path).toBe(fixture("no-code"));
    expect(module.bundle).toBeNull();
    expect(module.actions.size).toBe(0);
    expect(module.migrations.size).toBe(0);
  });

  it("loads a module with a bundle, its bodies by action id and by version", async () => {
    await buildModule(fixture("with-code"));
    const module = await modules.load(fixture("with-code"));
    expect(module.bundle).toBe(bundleOf("with-code"));
    expect([...module.actions.keys()]).toEqual(["greet/say_hello"]);
    expect([...module.migrations.keys()]).toEqual(["1.2.0"]);
    const emitted: unknown[] = [];
    const mcl = { runCommand: async (command: unknown) => (emitted.push(command), { after: [] }) };
    await module.actions.get("greet/say_hello")!(mcl, { name: " Ada " });
    expect(emitted).toEqual([{ kind: "create", schema: "greet.greeting", input: { text: "Hello, Ada!" } }]);
  });

  it("validates module.yaml as an instance of module", async () => {
    const folder = join(fixtures, "..", ".tmp-invalid");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "module.yaml"), "name: not a key\nnamespace: x\nversion: 1.0.0\nmcl: ^1.0\n");
    try {
      await expect(modules.load(folder)).rejects.toMatchObject({ code: "constraint_violation" });
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it("refuses a bundle that breaks the bundle check, without running it", async () => {
    const folder = join(fixtures, "..", ".tmp-unchecked");
    mkdirSync(join(folder, "dist"), { recursive: true });
    writeFileSync(join(folder, "module.yaml"), readFileSync(join(fixture("no-code"), "module.yaml")));
    writeFileSync(join(folder, "dist", "module.js"), "globalThis.ran = true;\nexport default {};\n");
    try {
      await expect(modules.load(folder)).rejects.toMatchObject({
        code: "constraint_violation",
        message: expect.stringContaining("globalThis"),
      });
      expect((globalThis as { ran?: boolean }).ran).toBeUndefined();
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it("refuses a default export that is not the result of defineModule", async () => {
    const folder = join(fixtures, "..", ".tmp-shape");
    mkdirSync(join(folder, "dist"), { recursive: true });
    writeFileSync(join(folder, "module.yaml"), readFileSync(join(fixture("no-code"), "module.yaml")));
    writeFileSync(join(folder, "dist", "module.js"), "export default 42;\n");
    try {
      await expect(modules.load(folder)).rejects.toMatchObject({
        code: "constraint_violation",
        message: expect.stringContaining("defineModule"),
      });
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it("refuses a declared action that has no body and no code", async () => {
    const folder = join(fixtures, "..", ".tmp-nobody");
    mkdirSync(folder, { recursive: true });
    writeFileSync(
      join(folder, "module.yaml"),
      "name: acme:empty\nnamespace: empty\nversion: 1.0.0\nmcl: ^1.0\nactions:\n  - id: empty/run\n    title: Run\n",
    );
    try {
      await expect(modules.load(folder)).rejects.toMatchObject({
        code: "constraint_violation",
        message: expect.stringContaining("empty/run"),
      });
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it("refuses a migration of the code that the manifest does not declare", async () => {
    const folder = join(fixtures, "..", ".tmp-migration");
    mkdirSync(join(folder, "dist"), { recursive: true });
    writeFileSync(join(folder, "module.yaml"), readFileSync(join(fixture("no-code"), "module.yaml")));
    writeFileSync(
      join(folder, "dist", "module.js"),
      'export default Object.freeze({ manifest: { name: "acme:plain", version: "1.0.0" }, actions: {}, migrations: { "2.0.0": () => 1 } });\n',
    );
    try {
      await expect(modules.load(folder)).rejects.toMatchObject({
        code: "constraint_violation",
        message: expect.stringContaining("2.0.0"),
      });
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it("refuses a bundle of another version of the module", async () => {
    const folder = join(fixtures, "..", ".tmp-stale");
    mkdirSync(join(folder, "dist"), { recursive: true });
    writeFileSync(join(folder, "module.yaml"), readFileSync(join(fixture("no-code"), "module.yaml")));
    writeFileSync(
      join(folder, "dist", "module.js"),
      'export default Object.freeze({ manifest: { name: "acme:plain", version: "0.9.0" }, actions: {}, migrations: {} });\n',
    );
    try {
      await expect(modules.load(folder)).rejects.toMatchObject({
        code: "constraint_violation",
        message: expect.stringContaining("0.9.0"),
      });
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
