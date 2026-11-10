import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AiChunk, AiFetch } from "../src/index.js";

export function fixture(name: string): string {
  return readFileSync(join(__dirname, "fixtures", name), "utf8");
}

/** A response of a recorded stream, cut in pieces of `size` bytes so lines and characters fall across reads. */
export function sse(text: string, size = 7): Response {
  const bytes = new TextEncoder().encode(text);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let at = 0; at < bytes.length; at += size) controller.enqueue(bytes.slice(at, at + size));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

export function failure(status: number, body: string): Response {
  return new Response(body, { status, headers: { "content-type": "application/json" } });
}

export interface Recorded {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** A fetch that answers with the given responses in order, and records the requests. */
export function fakeFetch(...answers: (Response | (() => Response | Promise<Response>))[]): AiFetch & {
  requests: Recorded[];
} {
  const requests: Recorded[] = [];
  const fetch = (async (url: string, init: { headers: Record<string, string>; body: string }) => {
    requests.push({ url, headers: init.headers, body: JSON.parse(init.body) as Record<string, unknown> });
    const answer = answers.shift();
    if (!answer) throw new Error("no more answers");
    return typeof answer === "function" ? answer() : answer;
  }) as unknown as AiFetch & { requests: Recorded[] };
  fetch.requests = requests;
  return fetch;
}

export async function collect(chunks: AsyncIterable<AiChunk>): Promise<AiChunk[]> {
  const all: AiChunk[] = [];
  for await (const chunk of chunks) all.push(chunk);
  return all;
}

export const connection = {
  kind: "byok",
  baseUrl: "https://api.example.test/v1/",
  apiKey: "sk-test",
  model: "gpt-4o-mini",
} as const;
