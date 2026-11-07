import { describe, expect, it } from "vitest";
import { defineModule } from "../src/index.js";

describe("defineModule", () => {
  const manifest = { name: "acme:greet", version: "1.0.0" };

  it("returns the manifest and the code, frozen", () => {
    const body = () => undefined;
    const module = defineModule(manifest, { actions: { say_hello: body } });
    expect(module.manifest).toBe(manifest);
    expect(module.actions).toEqual({ say_hello: body });
    expect(module.migrations).toEqual({});
    expect(Object.isFrozen(module)).toBe(true);
    expect(Object.isFrozen(module.actions)).toBe(true);
    expect(Object.isFrozen(module.migrations)).toBe(true);
  });

  it("takes no code", () => {
    expect(defineModule(manifest)).toMatchObject({ actions: {}, migrations: {} });
  });

  it("does not keep the objects it is given", () => {
    const actions: Record<string, () => void> = { a: () => undefined };
    const module = defineModule(manifest, { actions });
    actions.b = () => undefined;
    expect(Object.keys(module.actions)).toEqual(["a"]);
  });
});
