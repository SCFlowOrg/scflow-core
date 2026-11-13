/**
 * The types of a conversation with a language model (see `docs/ai.md`). Their
 * names are those of the `AiService` types of the framework, which re-exports
 * them.
 */

/** A call the model asks for. */
export interface AiToolCall {
  id: string;
  name: string;
  /** Raw JSON arguments as produced by the model. */
  arguments: string;
}

export interface AiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Images attached to a user message, as data URLs (`data:image/...;base64,...`). */
  images?: string[] | undefined;
  /** Tool calls the assistant asked for (assistant messages). */
  toolCalls?: AiToolCall[] | undefined;
  /** Which call this message answers (tool messages). */
  toolCallId?: string | undefined;
}

/**
 * A tool the model may call, in the shape of an MCP tool definition, so the
 * AI tools of `@scfloworg/actions` fit as they are.
 */
export interface AiToolSpec {
  name: string;
  title?: string | undefined;
  description?: string | undefined;
  /** The parameters, a JSON Schema object. */
  inputSchema: Readonly<Record<string, unknown>>;
  annotations?:
    | {
        readonly title?: string | undefined;
        readonly readOnlyHint?: boolean | undefined;
        readonly destructiveHint?: boolean | undefined;
      }
    | undefined;
}

export interface AiChatRequest {
  /** Overrides the model of the connection. */
  model?: string | undefined;
  messages: AiMessage[];
  tools?: readonly AiToolSpec[] | undefined;
  temperature?: number | undefined;
  /** The length limit of the answer, sent under the name the model takes. */
  maxTokens?: number | undefined;
}

/** The tokens of one answer, when the provider gives them. */
export interface AiTokens {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
}

/** A parameter the model refused, and the retry made without it. */
export interface AiRetry {
  parameter: string;
  /** The name sent instead, for the length limit. */
  replacedBy?: string | undefined;
  /** The message of the provider. */
  message: string;
}

export type AiChunk =
  | { type: "text"; text: string }
  | { type: "tool-call"; call: AiToolCall }
  | {
      type: "done";
      finishReason?: string | undefined;
      usage?: AiTokens | undefined;
      retried?: AiRetry | undefined;
    };

/** What `fetch` gets back, as far as the package reads it. */
export interface AiResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  readonly body: {
    getReader(): {
      read(): Promise<{ done: boolean; value?: Uint8Array | undefined }>;
      cancel?(): Promise<void>;
    };
  } | null;
  text(): Promise<string>;
}

/** An abort signal, as far as the package reads it; an `AbortSignal` fits. */
export interface AiSignal {
  readonly aborted: boolean;
  readonly reason?: unknown;
}

/**
 * The `fetch` the package calls; the global `fetch` fits. The signal is the
 * `AiSignal` the caller gave, typed loosely so a `fetch` that wants its own
 * `AbortSignal` type is accepted as it is.
 */
export type AiFetch = (
  url: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  init: { method: string; headers: Record<string, string>; body?: string; signal?: any },
) => Promise<AiResponse>;

export interface AiChatOptions {
  signal?: AiSignal | undefined;
}
