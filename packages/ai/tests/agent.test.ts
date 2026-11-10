import { createActionRegistry, toAiTools } from "@scfloworg/actions";
import { describe, expect, it } from "vitest";
import {
  createAiClient,
  runAgent,
  type AiChatRequest,
  type AiChunk,
  type AiEvent,
  type AiToolCall,
} from "../src/index.js";
import { connection, fakeFetch, fixture, sse } from "./helpers.js";

/** A client that answers each chat with the next script of chunks, and records the requests. */
function scripted(...answers: AiChunk[][]) {
  const requests: AiChatRequest[] = [];
  return {
    requests,
    async *chat(request: AiChatRequest): AsyncGenerator<AiChunk> {
      requests.push(structuredClone(request));
      const answer = answers.shift();
      if (!answer) throw new Error("no more answers");
      yield* answer;
    },
  };
}

const call = (id: string, name: string, args: unknown): AiChunk => ({
  type: "tool-call",
  call: { id, name, arguments: JSON.stringify(args) },
});
const done: AiChunk = { type: "done", finishReason: "stop" };
const tool = { name: "add", description: "Adds", inputSchema: { type: "object" } };

describe("the agent loop", () => {
  it("runs the calls, sends their results back, and stops when the model answers", async () => {
    const client = scripted(
      [call("c1", "add", { a: 1, b: 2 }), { type: "done", finishReason: "tool_calls" }],
      [{ type: "text", text: "3" }, done],
    );
    const executed: unknown[] = [];
    const outcome = await runAgent({
      client,
      messages: [{ role: "user", content: "1+2?" }],
      tools: [tool],
      execute: async (_call, args) => {
        executed.push(args);
        const { a, b } = args as { a: number; b: number };
        return { sum: a + b };
      },
    });
    expect(executed).toEqual([{ a: 1, b: 2 }]);
    expect(outcome).toMatchObject({ text: "3", turns: 2, stopped: "done" });
    expect(client.requests[1]?.messages).toEqual([
      { role: "user", content: "1+2?" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "add", arguments: '{"a":1,"b":2}' }],
      },
      { role: "tool", toolCallId: "c1", content: '{"sum":3}' },
    ]);
    expect(client.requests[0]?.tools).toEqual([tool]);
  });

  it("asks approval once per turn with all its calls, and answers refused calls with an error", async () => {
    const client = scripted(
      [call("c1", "add", {}), call("c2", "add", {}), call("c3", "add", {}), done],
      [done],
    );
    const approvals: AiToolCall[][] = [];
    const executed: string[] = [];
    const outcome = await runAgent({
      client,
      messages: [],
      tools: [tool],
      approve: async (calls) => {
        approvals.push(calls);
        return ["c1", "c3"];
      },
      execute: async (c) => {
        executed.push(c.id);
        return "ok";
      },
    });
    expect(approvals.map((calls) => calls.map((c) => c.id))).toEqual([["c1", "c2", "c3"]]);
    expect(executed).toEqual(["c1", "c3"]);
    const results = outcome.messages.filter((m) => m.role === "tool");
    expect(results.map((m) => [m.toolCallId, m.content])).toEqual([
      ["c1", '"ok"'],
      ["c2", JSON.stringify({ error: "The user refused this call." })],
      ["c3", '"ok"'],
    ]);
  });

  it("answers a call with bad arguments, an unknown tool or a failing execute, and goes on", async () => {
    const client = scripted(
      [
        { type: "tool-call", call: { id: "c1", name: "add", arguments: "{oops" } },
        call("c2", "nope", {}),
        call("c3", "add", {}),
        done,
      ],
      [{ type: "text", text: "sorry" }, done],
    );
    const outcome = await runAgent({
      client,
      messages: [],
      tools: [tool],
      execute: async () => {
        throw new Error("boom");
      },
    });
    const errors = outcome.messages
      .filter((m) => m.role === "tool")
      .map((m) => (JSON.parse(m.content) as { error: string }).error);
    expect(errors[0]).toMatch(/not valid JSON/);
    expect(errors[1]).toMatch(/no tool "nope"/);
    expect(errors[2]).toBe("boom");
    expect(outcome.stopped).toBe("done");
  });

  it("stops at the turn limit", async () => {
    const client = scripted([call("c1", "add", {}), done], [call("c2", "add", {}), done], [done]);
    const outcome = await runAgent({
      client,
      messages: [],
      tools: [tool],
      execute: async () => 0,
      maxTurns: 2,
    });
    expect(outcome).toMatchObject({ turns: 2, stopped: "turn-limit" });
    expect(client.requests).toHaveLength(2);
    expect(outcome.messages.at(-1)).toMatchObject({ role: "tool", toolCallId: "c2" });
  });

  it("stops before running a call once aborted", async () => {
    const controller = new AbortController();
    const client = scripted([call("c1", "add", {}), done]);
    const executed: string[] = [];
    const error = await runAgent({
      client,
      messages: [],
      tools: [tool],
      signal: controller.signal,
      approve: async () => {
        controller.abort();
        return true;
      },
      execute: async (c) => {
        executed.push(c.id);
      },
    }).catch((e: unknown) => e);
    expect(executed).toEqual([]);
    expect((error as Error).name).toBe("AbortError");
  });

  it("reports text, calls, results and answers as events, and passes the settings on", async () => {
    const client = scripted([{ type: "text", text: "a" }, call("c1", "add", {}), done], [done]);
    const events: AiEvent["type"][] = [];
    await runAgent({
      client,
      messages: [],
      tools: [tool],
      execute: async () => 1,
      onEvent: (event) => events.push(event.type),
      model: "m",
      temperature: 0,
      maxTokens: 5,
    });
    expect(events).toEqual(["text", "done", "tool-calls", "tool-result", "done"]);
    expect(client.requests[0]).toMatchObject({ model: "m", temperature: 0, maxTokens: 5 });
  });

  it("takes the tools of toAiTools as they are, with the transport", async () => {
    const registry = createActionRegistry();
    registry.register({
      id: "tasks/create_task",
      title: "Create a task",
      description: "Creates a task",
      kind: "action",
      parameters: {
        type: "object",
        properties: { title: { type: "string" } },
        required: ["title"],
      },
      run: (params: unknown) => ({ id: "t1", ...(params as object) }),
    });
    const tools = toAiTools(registry.list());
    const fetch = fakeFetch(sse(fixture("tool-calls.sse")), sse(fixture("text.sse")));
    const outcome = await runAgent({
      client: createAiClient({ connection, fetch }),
      messages: [{ role: "user", content: "Two tasks" }],
      tools,
      approve: async (calls) => calls.length === 2,
      execute: async (c, args) => (await registry.run(c.name.replace("-", "/"), args)).result,
    });
    expect(fetch.requests[0]?.body.tools).toEqual([
      {
        type: "function",
        function: {
          name: "tasks-create_task",
          description: "Creates a task",
          parameters: tools[0]?.inputSchema,
        },
      },
    ]);
    const results = outcome.messages
      .filter((m) => m.role === "tool")
      .map((m) => JSON.parse(m.content) as unknown);
    expect(results).toEqual([
      { id: "t1", title: "One" },
      { id: "t1", title: "Two" },
    ]);
    expect(outcome.text).toBe("Hello, wörld");
  });
});
