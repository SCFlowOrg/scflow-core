import { describe, it, expect, expectTypeOf } from "vitest";
import { createApiSession } from "../src/index.js";
import type {
  MclAccess,
  ModelActionDefinition,
  ModelActionParamsSchema,
} from "../src/index.js";

/**
 * `ModelActionDefinition` and `ModelActionParamsSchema` are exported from the
 * package entry point, and an action runs against any `MclAccess`.
 */
describe("ModelActionDefinition", () => {
  const parameters: ModelActionParamsSchema = {
    type: "object",
    properties: {
      name: { type: "string", description: "Name of the actor" },
    },
    required: ["name"],
    additionalProperties: false,
  };

  const createActor: ModelActionDefinition<{ name: string }, string> = {
    id: "test/create_actor",
    title: "Create actor",
    description: "Creates an actor with the given name.",
    parameters,
    async execute(access, locator, params) {
      expectTypeOf(access).toEqualTypeOf<MclAccess>();
      expectTypeOf(locator).toBeString();
      return `${locator}:${params.name}`;
    },
  };

  it("defaults its parameter and result types to unknown shapes", () => {
    expectTypeOf<ModelActionDefinition>().toHaveProperty("id").toBeString();
    expectTypeOf<ModelActionDefinition["execute"]>().returns.resolves.toBeUnknown();
  });

  it("executes against an MclAccess and a locator", async () => {
    const access: MclAccess = createApiSession();
    const result = await createActor.execute(access, "js:local/1", { name: "A" });
    expect(result).toBe("js:local/1:A");
  });

  it("carries a JSON Schema describing its parameters", () => {
    expect(createActor.parameters.type).toBe("object");
    expect(createActor.parameters.required).toEqual(["name"]);
  });
});
