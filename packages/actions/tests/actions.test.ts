import { describe, expect, it } from "vitest";
import {
  ActionError,
  actionIdOfTool,
  createActionRegistry,
  createRunLog,
  runBatch,
  toolName,
  validateParameters,
} from "../src/index.js";

describe("tool names", () => {
  it("replaces the slash of an id with a hyphen, and back", () => {
    expect(toolName("scflow/create_actor")).toBe("scflow-create_actor");
    expect(actionIdOfTool("scflow-create_actor")).toBe("scflow/create_actor");
    expect(actionIdOfTool("no_hyphen")).toBeUndefined();
  });
});

describe("validateParameters", () => {
  it("checks parameters against a definition without a registry", async () => {
    const definition = {
      id: "demo/a",
      parameters: { type: "object", properties: { n: { type: "integer" } } },
    };
    expect(await validateParameters(definition, { n: 1 })).toEqual({ n: 1 });
    const error = await validateParameters(definition, { n: "x" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ActionError);
    expect((error as ActionError).code).toBe("invalid_parameters");
    expect((error as ActionError).message).toContain("/n");
  });

  it("treats format as an annotation, since no format vocabulary is loaded", async () => {
    const definition = {
      id: "demo/a",
      parameters: { type: "object", properties: { at: { type: "string", format: "date-time" } } },
    };
    expect(await validateParameters(definition, { at: "not a date" })).toEqual({
      at: "not a date",
    });
  });
});

describe("run log", () => {
  it("keeps the top-level entries of the runs and batches it is given to", async () => {
    const registry = createActionRegistry();
    registry.register({ id: "demo/a", run: () => 1 });
    registry.register({ id: "demo/b", run: (_params, trace) => trace.call("demo/a") });
    const log = createRunLog();
    await registry.run("demo/b", {}, { onEntry: log.record });
    await runBatch(registry, { commands: [{ call: "demo/a" }] }, { onEntry: log.record });
    expect(log.entries.map((e) => e.action)).toEqual(["demo/b", "demo/a"]);
    expect(log.entries[0].steps).toHaveLength(1);
  });

  it("gives the body the context the host builds from the trace", async () => {
    const registry = createActionRegistry<{ emit(c: unknown): void }>();
    registry.register({
      id: "demo/a",
      run: (_params, context) => {
        context.emit({ query: "x" });
        return "ok";
      },
    });
    const { entry } = await registry.run(
      "demo/a",
      {},
      {
        context: (trace) => ({ emit: (c: unknown) => trace.command(c, { after: [] }) }),
      },
    );
    expect(entry.steps).toEqual([{ command: { query: "x" }, result: '{"after":[]}' }]);
  });
});
