import { describe, expect, it } from "vitest";
import { AiError, listModels, PROVIDERS, providerOf } from "../src/index.js";
import { connection, failure, fakeFetch } from "./helpers.js";

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("the catalogue of providers", () => {
  it("has unique ids and https URLs, but for local servers", () => {
    const ids = PROVIDERS.map((provider) => provider.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const provider of PROVIDERS) {
      const url = new URL(provider.baseUrl);
      const local = url.hostname === "localhost";
      expect(url.protocol).toBe(local ? "http:" : "https:");
      expect(provider.needsKey).toBe(!local);
      expect(provider.baseUrl.endsWith("/")).toBe(false);
    }
  });

  it("finds the provider of a base URL, with or without a trailing slash", () => {
    expect(providerOf("https://api.openai.com/v1/")?.id).toBe("openai");
    expect(providerOf("https://api.mistral.ai/v1")?.id).toBe("mistral");
    expect(providerOf("https://example.test/v1")).toBeUndefined();
  });
});

describe("listModels", () => {
  it("gets /models with the key and gives the ids sorted, each once", async () => {
    const fetch = fakeFetch(json({ data: [{ id: "b" }, { id: "a" }, { id: "b" }, {}] }));
    expect(await listModels(connection, { fetch })).toEqual(["a", "b"]);
    const [request] = fetch.requests;
    expect(request?.url).toBe("https://api.example.test/v1/models");
    expect(request?.method).toBe("GET");
    expect(request?.headers.Authorization).toBe("Bearer sk-test");
  });

  it("adds the connection headers and the Anthropic browser header", async () => {
    const fetch = fakeFetch(json({ data: [] }));
    await listModels(
      { ...connection, baseUrl: "https://api.anthropic.com/v1", headers: { "X-Title": "SCFlow" } },
      { fetch },
    );
    const [request] = fetch.requests;
    expect(request?.headers["X-Title"]).toBe("SCFlow");
    expect(request?.headers["anthropic-dangerous-direct-browser-access"]).toBe("true");
  });

  it("fails with auth when no key is set, before any request", async () => {
    const fetch = fakeFetch();
    const error = await listModels({ ...connection, apiKey: "" }, { fetch }).catch((e) => e);
    expect(error).toBeInstanceOf(AiError);
    expect(error.kind).toBe("auth");
    expect(fetch.requests).toHaveLength(0);
  });

  it("fails with auth when the key is refused", async () => {
    const fetch = fakeFetch(failure(401, '{"error":{"message":"Invalid key"}}'));
    const error = await listModels(connection, { fetch }).catch((e) => e);
    expect(error.kind).toBe("auth");
  });

  it("fails with network when nothing answers", async () => {
    const fetch = fakeFetch(() => Promise.reject(new TypeError("Failed to fetch")));
    const error = await listModels(connection, { fetch }).catch((e) => e);
    expect(error.kind).toBe("network");
  });

  it("fails with provider when the answer has no list", async () => {
    const fetch = fakeFetch(json({ models: [] }));
    const error = await listModels(connection, { fetch }).catch((e) => e);
    expect(error.kind).toBe("provider");
  });
});
