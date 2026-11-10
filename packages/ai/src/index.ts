/**
 * `@scfloworg/ai`, the neutral AI package: the types of a conversation with a
 * language model, the connections, the OpenAI-compatible transport over
 * `fetch`, the profiles of models, the normalized errors, the report of usage
 * and the agent loop. It depends on nothing and stores no key (see
 * `docs/ai.md`).
 */
export type {
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
  AiToolSpec,
} from "./types.js";
export type { AiConnection, AiConnectionKind, AiTransportKind, ByokConnection } from "./connection.js";
export { AiError } from "./errors.js";
export type { AiErrorKind } from "./errors.js";
export { DEFAULT_PROFILES, profileOf } from "./profiles.js";
export type { ModelProfile, ProfileRule } from "./profiles.js";
export { createAiClient } from "./client.js";
export type { AiClient, AiClientOptions, AiUsage } from "./client.js";
export { runAgent } from "./agent.js";
export type { AgentOptions, AgentOutcome, AiApproval, AiEvent } from "./agent.js";
