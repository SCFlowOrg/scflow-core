/**
 * The agent loop (see `docs/ai.md#the-agent-loop`): ask the model, run the
 * calls it makes, give back their results, and ask again, until it answers
 * with no call or the turn limit is reached.
 */

import type { AiClient } from "./client.js";
import type {
  AiChatRequest,
  AiChunk,
  AiMessage,
  AiSignal,
  AiToolCall,
  AiToolSpec,
} from "./types.js";

/** `true` approves every call of the turn, `false` none, a list of call ids those calls only. */
export type AiApproval = boolean | readonly string[];

export type AiEvent =
  | { type: "text"; text: string }
  | { type: "tool-calls"; calls: AiToolCall[] }
  | {
      type: "tool-result";
      call: AiToolCall;
      result?: unknown;
      error?: string | undefined;
      refused?: boolean;
    }
  | Extract<AiChunk, { type: "done" }>;

export interface AgentOptions {
  client: Pick<AiClient, "chat">;
  /** The conversation so far; the loop adds to a copy. */
  messages: readonly AiMessage[];
  tools: readonly AiToolSpec[];
  /** Runs one call; `args` are its arguments parsed. The result is sent back as JSON. */
  execute(call: AiToolCall, args: unknown): Promise<unknown>;
  /** Called once per turn with every call of the turn. Every call is approved when it is left out. */
  approve?: ((calls: AiToolCall[]) => Promise<AiApproval>) | undefined;
  /** The number of answers asked of the model; 10 by default. */
  maxTurns?: number | undefined;
  signal?: AiSignal | undefined;
  onEvent?: ((event: AiEvent) => void) | undefined;
  model?: string | undefined;
  temperature?: number | undefined;
  maxTokens?: number | undefined;
}

export interface AgentOutcome {
  messages: AiMessage[];
  /** The text of the last answer. */
  text: string;
  turns: number;
  /** `done` when the last answer asked for no call. */
  stopped: "done" | "turn-limit";
}

const REFUSED = "The user refused this call.";

function abortError(signal: AiSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  return Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
}

function throwIfAborted(signal: AiSignal | undefined): void {
  if (signal?.aborted) throw abortError(signal);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Runs the loop and gives the conversation it ends with. Errors of the model are thrown. */
export async function runAgent(options: AgentOptions): Promise<AgentOutcome> {
  const { client, tools, execute, approve, signal, onEvent } = options;
  const maxTurns = options.maxTurns ?? 10;
  const messages: AiMessage[] = [...options.messages];
  const known = new Set(tools.map((tool) => tool.name));
  const request: Omit<AiChatRequest, "messages"> = {};
  if (tools.length) request.tools = tools;
  if (options.model !== undefined) request.model = options.model;
  if (options.temperature !== undefined) request.temperature = options.temperature;
  if (options.maxTokens !== undefined) request.maxTokens = options.maxTokens;

  let text = "";
  for (let turn = 1; turn <= maxTurns; turn++) {
    throwIfAborted(signal);
    text = "";
    const calls: AiToolCall[] = [];
    for await (const chunk of client.chat(
      { ...request, messages: [...messages] },
      signal ? { signal } : {},
    )) {
      if (chunk.type === "text") text += chunk.text;
      if (chunk.type === "tool-call") calls.push(chunk.call);
      else onEvent?.(chunk);
    }
    messages.push(
      calls.length
        ? { role: "assistant", content: text, toolCalls: calls }
        : { role: "assistant", content: text },
    );
    if (!calls.length) return { messages, text, turns: turn, stopped: "done" };

    onEvent?.({ type: "tool-calls", calls });
    const approval = approve ? await approve(calls) : true;
    const approved = (call: AiToolCall) =>
      typeof approval === "boolean" ? approval : approval.includes(call.id);
    for (const call of calls) {
      throwIfAborted(signal);
      let content: unknown;
      let event: AiEvent;
      try {
        if (!approved(call)) {
          event = { type: "tool-result", call, error: REFUSED, refused: true };
          throw new Error(REFUSED);
        }
        if (!known.has(call.name)) throw new Error(`There is no tool "${call.name}"`);
        let args: unknown;
        try {
          args = call.arguments.trim() ? JSON.parse(call.arguments) : {};
        } catch {
          throw new Error(`The arguments are not valid JSON: ${call.arguments}`);
        }
        const result = await execute(call, args);
        content = result === undefined ? null : result;
        event = { type: "tool-result", call, result: content };
      } catch (error) {
        content = { error: message(error) };
        event ??= { type: "tool-result", call, error: message(error) };
      }
      onEvent?.(event);
      messages.push({ role: "tool", toolCallId: call.id, content: JSON.stringify(content) });
    }
  }
  return { messages, text, turns: maxTurns, stopped: "turn-limit" };
}
