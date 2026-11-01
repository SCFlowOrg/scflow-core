import { describe, it, expect, expectTypeOf } from "vitest";
import { createApiSession } from "../src/index.js";
import type { ApiSession, MclAccess } from "../src/index.js";

/**
 * `MclAccess` is exported from the package entry point and an
 * `ApiSession` is assignable to it, so a host can implement it on top
 * of the session it already holds.
 */
describe("MclAccess", () => {
  it("is implemented by ApiSession", () => {
    expectTypeOf<ApiSession>().toExtend<MclAccess>();
  });

  it("accepts a session where an MclAccess is expected", () => {
    const access: MclAccess = createApiSession();
    expect(typeof access.runCommand).toBe("function");
    expect(typeof access.runScript).toBe("function");
  });
});
