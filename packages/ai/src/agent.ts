/**
 * The agent loop (see `docs/ai.md#the-agent-loop`): ask the model, run the
 * calls it makes, give back their results, and ask again, until it answers
 * with no call or the turn limit is reached.
 */

import type { AiClient } from "./client.js";
import { AiError } from "./errors.js";
import type {
  AiChatRequest,
  AiChunk,
  AiMessage,
  AiModelTier,
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
  /** The loop moved from the `fast` tier to `strong` (see `docs/ai.md#escalation`). */
  | { type: "escalated"; reason: "call-failed" | "unsupported-parameter" }
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
  /** The model of every request; there is then nothing to escalate. */
  model?: string | undefined;
  /** The tier of the requests; `fast` to start with when `escalate` is set. */
  tier?: AiModelTier | undefined;
  /** Moves from `fast` to `strong` when the fast model fails (see `docs/ai.md#escalation`). */
  escalate?: boolean | undefined;
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
  /** `true` when the loop moved from `fast` to `strong`. */
  escalated: boolean;
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
  else if (options.tier !== undefined) request.tier = options.tier;
  else if (options.escalate) request.tier = "fast";
  if (options.temperature !== undefined) request.temperature = options.temperature;
  if (options.maxTokens !== undefined) request.maxTokens = options.maxTokens;

  let escalated = false;
  const canEscalate = () => options.escalate === true && request.tier === "fast";
  const escalate = (reason: "call-failed" | "unsupported-parameter") => {
    request.tier = "strong";
    escalated = true;
    onEvent?.({ type: "escalated", reason });
  };

  let text = "";
  for (let turn = 1; turn <= maxTurns; turn++) {
    throwIfAborted(signal);
    text = "";
    const calls: AiToolCall[] = [];
    for (;;) {
      try {
        for await (const chunk of client.chat(
          { ...request, messages: [...messages] },
          signal ? { signal } : {},
        )) {
          if (chunk.type === "text") text += chunk.text;
          if (chunk.type === "tool-call") calls.push(chunk.call);
          else onEvent?.(chunk);
        }
        break;
      } catch (error) {
        // A refused parameter is known before anything streams: the turn is asked again.
        const refused = error instanceof AiError && error.kind === "unsupported-parameter";
        if (!refused || !canEscalate() || text !== "" || calls.length) throw error;
        escalate("unsupported-parameter");
      }
    }
    messages.push(
      calls.length
        ? { role: "assistant", content: text, toolCalls: calls }
        : { role: "assistant", content: text },
    );
    if (!calls.length) return { messages, text, turns: turn, stopped: "done", escalated };

    onEvent?.({ type: "tool-calls", calls });
    const approval = approve ? await approve(calls) : true;
    const approved = (call: AiToolCall) =>
      typeof approval === "boolean" ? approval : approval.includes(call.id);
    let failed = false;
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
        // A call the user refused is not a failure of the model.
        if (approved(call)) failed = true;
        event ??= { type: "tool-result", call, error: message(error) };
      }
      onEvent?.(event);
      messages.push({ role: "tool", toolCallId: call.id, content: JSON.stringify(content) });
    }
    if (failed && canEscalate() && turn < maxTurns) escalate("call-failed");
  }
  return { messages, text, turns: maxTurns, stopped: "turn-limit", escalated };
}
