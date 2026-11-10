import { describe, expect, it } from "vitest";
import { AiError, createAiClient, profileOf, type AiUsage } from "../src/index.js";
import { collect, connection, failure, fakeFetch, fixture, sse } from "./helpers.js";

describe("the OpenAI-compatible transport", () => {
  it("streams text, then done with the finish reason and the usage", async () => {
    const fetch = fakeFetch(sse(fixture("text.sse")));
    const client = createAiClient({ connection, fetch });
    const chunks = await collect(client.chat({ messages: [{ role: "user", content: "Hi" }] }));
    expect(chunks).toEqual([
      { type: "text", text: "Hello" },
      { type: "text", text: ", wörld" },
      { type: "done", finishReason: "stop", usage: { inputTokens: 12, outputTokens: 4 } },
    ]);
  });

  it("posts to /chat/completions with the key and a streamed body", async () => {
    const fetch = fakeFetch(sse(fixture("text.sse")));
    const client = createAiClient({ connection, fetch });
    await collect(client.chat({ messages: [{ role: "user", content: "Hi" }], temperature: 0.2, maxTokens: 100 }));
    const [request] = fetch.requests;
    expect(request?.url).toBe("https://api.example.test/v1/chat/completions");
    expect(request?.headers.Authorization).toBe("Bearer sk-test");
    expect(request?.headers["anthropic-dangerous-direct-browser-access"]).toBeUndefined();
    expect(request?.body).toEqual({
      model: "gpt-4o-mini",
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: "user", content: "Hi" }],
      temperature: 0.2,
      max_tokens: 100,
    });
  });

  it("assembles the tool calls of one answer, each whole, after the text", async () => {
    const client = createAiClient({ connection, fetch: fakeFetch(sse(fixture("tool-calls.sse"), 3)) });
    const chunks = await collect(client.chat({ messages: [{ role: "user", content: "Two tasks" }] }));
    expect(chunks).toEqual([
      { type: "tool-call", call: { id: "call_a1", name: "tasks-create_task", arguments: '{"title": "One"}' } },
      { type: "tool-call", call: { id: "call_b2", name: "tasks-create_task", arguments: '{"title": "Two"}' } },
      { type: "done", finishReason: "tool_calls", usage: { inputTokens: 85, outputTokens: 40 } },
    ]);
  });

  it("reads a stream with comments and no usage, and a length finish", async () => {
    const client = createAiClient({ connection, fetch: fakeFetch(sse(fixture("length.sse"))) });
    const chunks = await collect(client.chat({ messages: [{ role: "user", content: "x" }] }));
    expect(chunks).toEqual([
      { type: "text", text: "Cut" },
      { type: "done", finishReason: "length" },
    ]);
  });

  it("sends images, tool calls, tool results and tools in the wire shape", async () => {
    const fetch = fakeFetch(sse(fixture("text.sse")));
    const client = createAiClient({ connection, fetch });
    await collect(
      client.chat({
        messages: [
          { role: "user", content: "Look", images: ["data:image/png;base64,AAAA"] },
          { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "t", arguments: "{}" }] },
          { role: "tool", content: '{"ok":true}', toolCallId: "c1" },
        ],
        tools: [{ name: "t", description: "A tool", inputSchema: { type: "object", properties: {} } }],
      }),
    );
    const body = fetch.requests[0]?.body;
    expect(body?.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "Look" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
        ],
      },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "c1", type: "function", function: { name: "t", arguments: "{}" } }],
      },
      { role: "tool", content: '{"ok":true}', tool_call_id: "c1" },
    ]);
    expect(body?.tools).toEqual([
      {
        type: "function",
        function: { name: "t", description: "A tool", parameters: { type: "object", properties: {} } },
      },
    ]);
    expect(body?.tool_choice).toBe("auto");
  });

  it("adds the browser header of Anthropic on its host only, and the headers of the connection", async () => {
    const fetch = fakeFetch(sse(fixture("text.sse")));
    const client = createAiClient({
      connection: { ...connection, baseUrl: "https://api.anthropic.com/v1", headers: { "X-Title": "SCFlow" } },
      fetch,
    });
    await collect(client.chat({ messages: [{ role: "user", content: "Hi" }] }));
    expect(fetch.requests[0]?.headers["anthropic-dangerous-direct-browser-access"]).toBe("true");
    expect(fetch.requests[0]?.headers["X-Title"]).toBe("SCFlow");
  });

  it("uses the model of the request over the model of the connection", async () => {
    const fetch = fakeFetch(sse(fixture("text.sse")));
    await collect(createAiClient({ connection, fetch }).chat({ model: "other", messages: [] }));
    expect(fetch.requests[0]?.body.model).toBe("other");
  });
});

describe("model profiles", () => {
  it("match a family without case and without a provider prefix", () => {
    expect(profileOf("o3-mini")).toEqual({ temperature: false, lengthLimit: "max_completion_tokens" });
    expect(profileOf("openai/GPT-5.1")).toEqual({ temperature: false, lengthLimit: "max_completion_tokens" });
    expect(profileOf("gpt-4o-mini")).toBeUndefined();
  });

  it("let the rules of the host come before the defaults", () => {
    expect(profileOf("o3", [{ match: "o3", profile: { tools: false } }])).toEqual({ tools: false });
    expect(profileOf("llava:7b", [{ match: "llava*", profile: { tools: false } }])).toEqual({ tools: false });
  });

  it("drop temperature and rename the length limit for a reasoning model", async () => {
    const fetch = fakeFetch(sse(fixture("text.sse")));
    const client = createAiClient({ connection: { ...connection, model: "o4-mini" }, fetch });
    await collect(client.chat({ messages: [], temperature: 0.2, maxTokens: 50 }));
    const body = fetch.requests[0]?.body ?? {};
    expect("temperature" in body).toBe(false);
    expect(body.max_completion_tokens).toBe(50);
    expect("max_tokens" in body).toBe(false);
  });

  it("refuse images or tools the model does not take, before sending", async () => {
    const fetch = fakeFetch();
    const client = createAiClient({ connection, fetch, profiles: [{ match: "*", profile: { images: false } }] });
    const error = await collect(
      client.chat({ messages: [{ role: "user", content: "x", images: ["data:image/png;base64,AA"] }] }),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiError);
    expect(error).toMatchObject({ kind: "unsupported-parameter", parameter: "images" });
    expect(fetch.requests).toHaveLength(0);
  });
});

describe("errors", () => {
  const cases = [
    { file: "auth.json", status: 401, kind: "auth" },
    { file: "rate-limit.json", status: 429, kind: "rate-limit" },
    { file: "context-length.json", status: 400, kind: "context-length" },
    { file: "model-not-found.json", status: 404, kind: "model-not-found" },
  ] as const;

  for (const { file, status, kind } of cases) {
    it(`gives ${kind} for a ${status}, with the message of the provider`, async () => {
      const body = fixture(file);
      const client = createAiClient({ connection, fetch: fakeFetch(failure(status, body)) });
      const error = (await collect(client.chat({ messages: [] })).catch((e: unknown) => e)) as AiError;
      expect(error).toBeInstanceOf(AiError);
      expect(error.kind).toBe(kind);
      expect(error.status).toBe(status);
      expect(error.message).toContain((JSON.parse(body) as { error: { message: string } }).error.message);
    });
  }

  it("gives provider for a 500 with a body that is not JSON", async () => {
    const client = createAiClient({ connection, fetch: fakeFetch(failure(500, "<html>Bad gateway</html>")) });
    const error = (await collect(client.chat({ messages: [] })).catch((e: unknown) => e)) as AiError;
    expect(error).toMatchObject({ kind: "provider", status: 500 });
    expect(error.message).toContain("Bad gateway");
  });

  it("gives auth with no key, before sending", async () => {
    const fetch = fakeFetch();
    const client = createAiClient({ connection: { ...connection, apiKey: "" }, fetch });
    await expect(collect(client.chat({ messages: [] }))).rejects.toMatchObject({ kind: "auth" });
    expect(fetch.requests).toHaveLength(0);
  });

  it("gives network when fetch fails", async () => {
    const client = createAiClient({
      connection,
      fetch: fakeFetch(() => {
        throw new TypeError("fetch failed");
      }),
    });
    await expect(collect(client.chat({ messages: [] }))).rejects.toMatchObject({
      kind: "network",
      message: expect.stringContaining("fetch failed"),
    });
  });

  it("gives provider for an error inside the stream, after the text before it", async () => {
    const client = createAiClient({ connection, fetch: fakeFetch(sse(fixture("stream-error.sse"))) });
    const seen: string[] = [];
    const error = await (async () => {
      for await (const chunk of client.chat({ messages: [] })) if (chunk.type === "text") seen.push(chunk.text);
    })().catch((e: unknown) => e);
    expect(seen).toEqual(["Par"]);
    expect(error).toMatchObject({ kind: "provider", message: expect.stringContaining("upstream provider failed") });
  });

  it("throws the abort error as it is", async () => {
    const controller = new AbortController();
    controller.abort();
    const client = createAiClient({
      connection,
      fetch: fakeFetch(() => {
        throw new DOMException("The operation was aborted.", "AbortError");
      }),
    });
    const error = await collect(client.chat({ messages: [] }, { signal: controller.signal })).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(AiError);
    expect((error as Error).name).toBe("AbortError");
  });
});

describe("the retry without a refused parameter", () => {
  it("drops temperature, retries once and reports it", async () => {
    const fetch = fakeFetch(failure(400, fixture("unsupported-temperature.json")), sse(fixture("text.sse")));
    const usages: AiUsage[] = [];
    const client = createAiClient({ connection, fetch, onUsage: (usage) => usages.push(usage) });
    const chunks = await collect(client.chat({ messages: [], temperature: 0.2 }));
    expect(fetch.requests).toHaveLength(2);
    expect("temperature" in (fetch.requests[1]?.body ?? {})).toBe(false);
    const retried = { parameter: "temperature", message: expect.stringContaining("'temperature' does not support") };
    expect(chunks.at(-1)).toMatchObject({ type: "done", retried });
    expect(usages[0]).toMatchObject({ outcome: "ok", retried });
  });

  it("renames max_tokens to max_completion_tokens", async () => {
    const fetch = fakeFetch(failure(400, fixture("unsupported-max-tokens.json")), sse(fixture("text.sse")));
    const client = createAiClient({ connection, fetch });
    const chunks = await collect(client.chat({ messages: [], maxTokens: 64 }));
    expect(fetch.requests[1]?.body.max_completion_tokens).toBe(64);
    expect("max_tokens" in (fetch.requests[1]?.body ?? {})).toBe(false);
    expect(chunks.at(-1)).toMatchObject({ retried: { parameter: "max_tokens", replacedBy: "max_completion_tokens" } });
  });

  it("finds the parameter in the message when the provider names no param", async () => {
    const body = JSON.stringify({ error: { message: "stream_options: Extra inputs are not permitted" } });
    const fetch = fakeFetch(failure(400, body), sse(fixture("length.sse")));
    const chunks = await collect(createAiClient({ connection, fetch }).chat({ messages: [] }));
    expect("stream_options" in (fetch.requests[1]?.body ?? {})).toBe(false);
    expect(chunks.at(-1)).toMatchObject({ retried: { parameter: "stream_options" } });
  });

  it("throws unsupported-parameter on a second refusal", async () => {
    const fetch = fakeFetch(
      failure(400, fixture("unsupported-temperature.json")),
      failure(400, fixture("unsupported-max-tokens.json")),
    );
    const client = createAiClient({ connection, fetch });
    const error = await collect(client.chat({ messages: [], temperature: 0.2, maxTokens: 9 })).catch((e: unknown) => e);
    expect(fetch.requests).toHaveLength(2);
    expect(error).toMatchObject({ kind: "unsupported-parameter", parameter: "max_tokens" });
  });
});

describe("usage", () => {
  it("reports the model, the kind, the tokens, the duration and the outcome", async () => {
    const usages: AiUsage[] = [];
    let clock = 1000;
    const client = createAiClient({
      connection,
      fetch: fakeFetch(sse(fixture("text.sse"))),
      onUsage: (usage) => usages.push(usage),
      now: () => (clock += 250),
    });
    await collect(client.chat({ messages: [] }));
    expect(usages).toEqual([
      {
        model: "gpt-4o-mini",
        connection: "byok",
        inputTokens: 12,
        outputTokens: 4,
        durationMs: 250,
        outcome: "ok",
      },
    ]);
  });

  it("reports an error with its kind, and ignores a failing callback", async () => {
    const usages: AiUsage[] = [];
    const client = createAiClient({
      connection,
      fetch: fakeFetch(failure(401, fixture("auth.json"))),
      onUsage: (usage) => {
        usages.push(usage);
        throw new Error("ignored");
      },
    });
    await expect(collect(client.chat({ messages: [] }))).rejects.toMatchObject({ kind: "auth" });
    expect(usages[0]).toMatchObject({ outcome: "error", error: "auth" });
  });

  it("reports aborted when the caller stops reading", async () => {
    const usages: AiUsage[] = [];
    const client = createAiClient({
      connection,
      fetch: fakeFetch(sse(fixture("text.sse"))),
      onUsage: (usage) => usages.push(usage),
    });
    for await (const chunk of client.chat({ messages: [] })) if (chunk.type === "text") break;
    expect(usages).toHaveLength(1);
    expect(usages[0]?.outcome).toBe("aborted");
  });
});
