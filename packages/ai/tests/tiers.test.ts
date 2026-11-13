import { describe, expect, it } from "vitest";
import {
  AiError,
  createAiClient,
  runAgent,
  type AiChatRequest,
  type AiChunk,
  type AiEvent,
} from "../src/index.js";
import { collect, connection, fakeFetch, fixture, sse } from "./helpers.js";

const tiered = { ...connection, models: { fast: "small-1", strong: "large-1" } };

async function modelOf(request: Partial<AiChatRequest>, conn: typeof connection = tiered) {
  const fetch = fakeFetch(sse(fixture("text.sse")));
  const client = createAiClient({ connection: conn, fetch });
  await collect(client.chat({ messages: [{ role: "user", content: "Hi" }], ...request }));
  return fetch.requests[0]?.body.model;
}

describe("the tiers of a connection", () => {
  it("send the model of the tier asked", async () => {
    expect(await modelOf({ tier: "fast" })).toBe("small-1");
    expect(await modelOf({ tier: "strong" })).toBe("large-1");
  });

  it("give way to the model of the request", async () => {
    expect(await modelOf({ tier: "strong", model: "other" })).toBe("other");
  });

  it("are the model of the connection when no tier or no model of it is set", async () => {
    expect(await modelOf({})).toBe("gpt-4o-mini");
    expect(await modelOf({ tier: "strong" }, connection)).toBe("gpt-4o-mini");
    expect(
      await modelOf({ tier: "strong" }, { ...connection, models: { fast: "small-1" } } as never),
    ).toBe("gpt-4o-mini");
  });
});

/** A client that answers each chat with the next answer: chunks, or an error thrown. */
function scripted(...answers: (AiChunk[] | Error)[]) {
  const requests: AiChatRequest[] = [];
  return {
    requests,
    async *chat(request: AiChatRequest): AsyncGenerator<AiChunk> {
      requests.push(structuredClone(request));
      const answer = answers.shift();
      if (!answer) throw new Error("no more answers");
      if (answer instanceof Error) throw answer;
      yield* answer;
    },
  };
}

const call = (id: string, name: string, args: string): AiChunk => ({
  type: "tool-call",
  call: { id, name, arguments: args },
});
const asks: AiChunk = { type: "done", finishReason: "tool_calls" };
const done: AiChunk = { type: "done", finishReason: "stop" };
const tool = { name: "add", description: "Adds", inputSchema: { type: "object" } };
const messages = [{ role: "user" as const, content: "Go" }];

describe("escalation in the agent loop", () => {
  it("passes the tier with each request, and does not escalate when not asked", async () => {
    const client = scripted([call("c1", "nope", "{}"), asks], [done]);
    const outcome = await runAgent({
      client,
      messages,
      tools: [tool],
      tier: "fast",
      execute: async () => 1,
    });
    expect(client.requests.map((request) => request.tier)).toEqual(["fast", "fast"]);
    expect(outcome.escalated).toBe(false);
  });

  it("starts fast and moves to strong after a failed call, for the rest of the run", async () => {
    const client = scripted(
      [call("c1", "add", "{not json"), asks],
      [call("c2", "add", "{}"), asks],
      [done],
    );
    const events: AiEvent[] = [];
    const outcome = await runAgent({
      client,
      messages,
      tools: [tool],
      escalate: true,
      execute: async () => 1,
      onEvent: (event) => events.push(event),
    });
    expect(client.requests.map((request) => request.tier)).toEqual(["fast", "strong", "strong"]);
    expect(events.filter((event) => event.type === "escalated")).toEqual([
      { type: "escalated", reason: "call-failed" },
    ]);
    expect(outcome.escalated).toBe(true);
  });

  it("escalates when execute throws, or the tool is unknown", async () => {
    for (const failing of [call("c1", "add", "{}"), call("c1", "nope", "{}")]) {
      const client = scripted([failing, asks], [done]);
      await runAgent({
        client,
        messages,
        tools: [tool],
        escalate: true,
        execute: async () => {
          throw new Error("boom");
        },
      });
      expect(client.requests.map((request) => request.tier)).toEqual(["fast", "strong"]);
    }
  });

  it("does not escalate when the user refuses a call", async () => {
    const client = scripted([call("c1", "add", "{}"), asks], [done]);
    const outcome = await runAgent({
      client,
      messages,
      tools: [tool],
      escalate: true,
      approve: async () => false,
      execute: async () => 1,
    });
    expect(client.requests.map((request) => request.tier)).toEqual(["fast", "fast"]);
    expect(outcome.escalated).toBe(false);
  });

  it("asks the same turn again of the strong model when the fast one refuses a parameter", async () => {
    const refused = new AiError("unsupported-parameter", "The model small-1 takes no tools", {
      parameter: "tools",
    });
    const client = scripted(refused, [{ type: "text", text: "ok" }, done]);
    const events: AiEvent[] = [];
    const outcome = await runAgent({
      client,
      messages,
      tools: [tool],
      escalate: true,
      execute: async () => 1,
      onEvent: (event) => events.push(event),
    });
    expect(client.requests.map((request) => request.tier)).toEqual(["fast", "strong"]);
    expect(client.requests[1]?.messages).toEqual(messages);
    expect(events[0]).toEqual({ type: "escalated", reason: "unsupported-parameter" });
    expect(outcome).toMatchObject({ text: "ok", turns: 1, escalated: true });
  });

  it("throws the error of the strong model, and every error when not escalating", async () => {
    const refused = () => new AiError("unsupported-parameter", "no tools", { parameter: "tools" });
    const twice = scripted(refused(), refused());
    await expect(
      runAgent({ client: twice, messages, tools: [tool], escalate: true, execute: async () => 1 }),
    ).rejects.toMatchObject({ kind: "unsupported-parameter" });
    expect(twice.requests).toHaveLength(2);

    const once = scripted(refused());
    await expect(
      runAgent({ client: once, messages, tools: [tool], execute: async () => 1 }),
    ).rejects.toMatchObject({ kind: "unsupported-parameter" });
    expect(once.requests).toHaveLength(1);
  });

  it("starts strong when the tier says so, and has nothing to escalate", async () => {
    const client = scripted([call("c1", "nope", "{}"), asks], [done]);
    const outcome = await runAgent({
      client,
      messages,
      tools: [tool],
      tier: "strong",
      escalate: true,
      execute: async () => 1,
    });
    expect(client.requests.map((request) => request.tier)).toEqual(["strong", "strong"]);
    expect(outcome.escalated).toBe(false);
  });

  it("does not escalate when a model is given", async () => {
    const client = scripted([call("c1", "nope", "{}"), asks], [done]);
    const outcome = await runAgent({
      client,
      messages,
      tools: [tool],
      model: "fixed",
      escalate: true,
      execute: async () => 1,
    });
    expect(client.requests.map((request) => [request.model, request.tier])).toEqual([
      ["fixed", undefined],
      ["fixed", undefined],
    ]);
    expect(outcome.escalated).toBe(false);
  });
});
