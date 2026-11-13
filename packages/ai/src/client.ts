/**
 * The client of a connection: one chat streams one answer (see `docs/ai.md`).
 * The OpenAI-compatible transport is here: `POST {baseUrl}/chat/completions`
 * streamed as server-sent events, read with the global `fetch` or the host's.
 */

import {
  requestHeaders,
  resolveConnection,
  type AiConnection,
  type AiConnectionKind,
} from "./connection.js";
import { AiError, errorOfAnswer, readProviderError, type AiErrorKind } from "./errors.js";
import { profileOf, type ModelProfile, type ProfileRule } from "./profiles.js";
import type {
  AiChatOptions,
  AiChatRequest,
  AiChunk,
  AiFetch,
  AiMessage,
  AiResponse,
  AiRetry,
  AiSignal,
  AiTokens,
  AiToolCall,
} from "./types.js";

/** The report of one chat, given to `onUsage` at its end. */
export interface AiUsage extends AiTokens {
  /** The model the request named. */
  model: string;
  connection: AiConnectionKind;
  durationMs: number;
  /** `aborted` when the signal fired or the caller stopped reading. */
  outcome: "ok" | "aborted" | "error";
  /** The kind of the error, with `outcome: "error"`. */
  error?: AiErrorKind | undefined;
  retried?: AiRetry | undefined;
}

export interface AiClientOptions {
  connection: AiConnection;
  /** Rules tried before `DEFAULT_PROFILES`. */
  profiles?: readonly ProfileRule[] | undefined;
  /** Called once per chat, at its end; what it throws is ignored. */
  onUsage?: ((usage: AiUsage) => void) | undefined;
  /** The global `fetch` by default. */
  fetch?: AiFetch | undefined;
  /** The clock of `durationMs`, in milliseconds; `Date.now` by default. */
  now?: (() => number) | undefined;
}

export interface AiClient {
  readonly connection: AiConnection;
  /** Streams one answer. The tool calls come whole after the text, then `done`. */
  chat(request: AiChatRequest, options?: AiChatOptions): AsyncIterable<AiChunk>;
}

/** The parameters the transport may drop or rename when the model refuses them. */
type Optional = Record<string, unknown>;

const LENGTH_NAMES: Record<string, string> = {
  max_tokens: "max_completion_tokens",
  max_completion_tokens: "max_tokens",
};

function wireMessage(message: AiMessage): Record<string, unknown> {
  if (message.role === "tool") {
    return { role: "tool", content: message.content, tool_call_id: message.toolCallId };
  }
  if (message.toolCalls?.length) {
    return {
      role: message.role,
      content: message.content || null,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments },
      })),
    };
  }
  if (message.role === "user" && message.images?.length) {
    return {
      role: "user",
      content: [
        ...(message.content ? [{ type: "text", text: message.content }] : []),
        ...message.images.map((url) => ({ type: "image_url", image_url: { url } })),
      ],
    };
  }
  return { role: message.role, content: message.content };
}

function optionalParameters(request: AiChatRequest, profile: ModelProfile | undefined): Optional {
  const optional: Optional = { stream_options: { include_usage: true } };
  if (request.temperature !== undefined && profile?.temperature !== false)
    optional.temperature = request.temperature;
  if (request.maxTokens !== undefined)
    optional[profile?.lengthLimit ?? "max_tokens"] = request.maxTokens;
  return optional;
}

function checkProfile(
  request: AiChatRequest,
  profile: ModelProfile | undefined,
  model: string,
): void {
  const refuse = (parameter: string, what: string) =>
    new AiError("unsupported-parameter", `The model ${model} takes no ${what}`, { parameter });
  if (profile?.images === false && request.messages.some((message) => message.images?.length)) {
    throw refuse("images", "image");
  }
  if (profile?.tools === false && request.tools?.length) throw refuse("tools", "tool");
}

/** Drops the refused parameter, or gives the length limit its other name. */
function withoutRefused(
  optional: Optional,
  error: AiError,
): { optional: Optional; retried: AiRetry } {
  const parameter = error.parameter as string;
  const { [parameter]: value, ...rest } = optional;
  const replacedBy = LENGTH_NAMES[parameter];
  if (replacedBy) rest[replacedBy] = value;
  const retried: AiRetry = { parameter, message: error.message };
  if (replacedBy) retried.replacedBy = replacedBy;
  return { optional: rest, retried };
}

function isAbort(error: unknown, signal: AiSignal | undefined): boolean {
  return signal?.aborted === true || (error as { name?: unknown } | null)?.name === "AbortError";
}

interface Decoder {
  decode(input?: Uint8Array, options?: { stream?: boolean }): string;
}

function decoder(): Decoder {
  const Constructor = (globalThis as unknown as { TextDecoder: new () => Decoder }).TextDecoder;
  return new Constructor();
}

/** The `data:` payloads of a stream of server-sent events, `[DONE]` left out. */
async function* events(
  body: NonNullable<AiResponse["body"]>,
  signal: AiSignal | undefined,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const text = decoder();
  let buffer = "";
  let ended = false;
  try {
    while (true) {
      let read: { done: boolean; value?: Uint8Array | undefined };
      try {
        read = await reader.read();
      } catch (error) {
        if (isAbort(error, signal)) throw error;
        throw new AiError(
          "network",
          `The stream was cut: ${(error as Error)?.message ?? String(error)}`,
          {
            cause: error,
          },
        );
      }
      buffer += read.done ? text.decode() : text.decode(read.value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = read.done ? "" : (lines.pop() ?? "");
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data && data !== "[DONE]") yield data;
      }
      if (read.done) break;
    }
    ended = true;
  } finally {
    if (!ended) await reader.cancel?.().catch(() => undefined);
  }
}

interface StreamPayload {
  choices?: {
    delta?: {
      content?: string | null;
      tool_calls?: {
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
    finish_reason?: string | null;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
  error?: unknown;
}

function streamError(payload: StreamPayload): AiError {
  const provider = readProviderError(JSON.stringify(payload));
  const code = (payload.error as { code?: unknown } | null)?.code;
  if (typeof code === "number" && code >= 400)
    return errorOfAnswer(code, "", JSON.stringify(payload), []);
  return new AiError("provider", provider.message);
}

/** Creates the client of one connection. It keeps nothing between chats. */
export function createAiClient(options: AiClientOptions): AiClient {
  const { connection, profiles, onUsage } = options;
  const now = options.now ?? (() => Date.now());

  async function* chat(
    request: AiChatRequest,
    chatOptions: AiChatOptions = {},
  ): AsyncGenerator<AiChunk> {
    const { signal } = chatOptions;
    const model = request.model ?? connection.model;
    const started = now();
    const usage: AiUsage = {
      model,
      connection: connection.kind,
      durationMs: 0,
      outcome: "aborted",
    };
    try {
      const profile = profileOf(model, profiles);
      checkProfile(request, profile, model);
      const resolved = resolveConnection(connection);
      const credential = await resolved.credential();
      if (!credential) throw new AiError("auth", "No API key is set for this connection");

      const url = `${resolved.baseUrl}/chat/completions`;
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...requestHeaders(resolved, credential, url),
      };
      const base: Record<string, unknown> = {
        model,
        stream: true,
        messages: request.messages.map(wireMessage),
      };
      if (request.tools?.length) {
        base.tools = request.tools.map((tool) => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description ?? "",
            parameters: tool.inputSchema,
          },
        }));
        base.tool_choice = "auto";
      }

      const fetch = options.fetch ?? (globalThis as unknown as { fetch: AiFetch }).fetch;
      const send = async (optional: Optional): Promise<AiResponse> => {
        try {
          return await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify({ ...base, ...optional }),
            ...(signal ? { signal } : {}),
          });
        } catch (error) {
          if (isAbort(error, signal)) throw error;
          throw new AiError(
            "network",
            `No answer from ${url}: ${(error as Error)?.message ?? String(error)}`,
            {
              cause: error,
            },
          );
        }
      };
      const failed = async (response: AiResponse, optional: Optional): Promise<AiError> =>
        errorOfAnswer(
          response.status,
          response.statusText,
          await response.text().catch(() => ""),
          Object.keys(optional),
        );

      let optional = optionalParameters(request, profile);
      let response = await send(optional);
      let retried: AiRetry | undefined;
      if (!response.ok) {
        const error = await failed(response, optional);
        if (error.kind !== "unsupported-parameter" || error.parameter === undefined) throw error;
        ({ optional, retried } = withoutRefused(optional, error));
        usage.retried = retried;
        response = await send(optional);
        if (!response.ok) throw await failed(response, optional);
      }
      if (!response.body)
        throw new AiError("provider", `${url} answered with no body`, { status: response.status });

      const calls = new Map<number, AiToolCall>();
      let finishReason: string | undefined;
      for await (const data of events(response.body, signal)) {
        let payload: StreamPayload;
        try {
          payload = JSON.parse(data) as StreamPayload;
        } catch {
          continue;
        }
        if (payload.error) throw streamError(payload);
        if (payload.usage) {
          if (payload.usage.prompt_tokens !== undefined)
            usage.inputTokens = payload.usage.prompt_tokens;
          if (payload.usage.completion_tokens !== undefined)
            usage.outputTokens = payload.usage.completion_tokens;
        }
        const choice = payload.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;
        const text = choice.delta?.content;
        if (text) yield { type: "text", text };
        for (const delta of choice.delta?.tool_calls ?? []) {
          const current = calls.get(delta.index) ?? { id: "", name: "", arguments: "" };
          calls.set(delta.index, {
            id: delta.id ?? current.id,
            name: delta.function?.name ?? current.name,
            arguments: current.arguments + (delta.function?.arguments ?? ""),
          });
        }
      }

      for (const [index, call] of [...calls.entries()].sort(([a], [b]) => a - b)) {
        yield { type: "tool-call", call: { ...call, id: call.id || `call-${index}` } };
      }
      const tokens: AiTokens = {};
      if (usage.inputTokens !== undefined) tokens.inputTokens = usage.inputTokens;
      if (usage.outputTokens !== undefined) tokens.outputTokens = usage.outputTokens;
      usage.outcome = "ok";
      yield {
        type: "done",
        ...(finishReason ? { finishReason } : {}),
        ...(Object.keys(tokens).length ? { usage: tokens } : {}),
        ...(retried ? { retried } : {}),
      };
    } catch (error) {
      if (isAbort(error, signal)) usage.outcome = "aborted";
      else {
        usage.outcome = "error";
        usage.error = error instanceof AiError ? error.kind : "provider";
      }
      throw error;
    } finally {
      usage.durationMs = now() - started;
      try {
        onUsage?.(usage);
      } catch {
        // The report never breaks the chat.
      }
    }
  }

  return { connection, chat };
}
