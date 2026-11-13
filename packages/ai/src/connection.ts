/**
 * The connections a request goes through (see `docs/ai.md#connections`).
 * `byok` is the only kind today; a service connection will be a second member
 * of `AiConnection`, so hosts write their code against the union.
 */

import type { AiChatRequest, AiModelTier } from "./types.js";

/** How to talk to a connection. */
export type AiTransportKind = "openai-compatible";

/** The user's own key, sent straight to the provider. */
export interface ByokConnection {
  kind: "byok";
  /** Base URL of the API, e.g. `https://api.openai.com/v1`. */
  baseUrl: string;
  apiKey: string;
  /** The model used when a request names none, and for a tier `models` leaves out. */
  model: string;
  /** The model of each tier (see `docs/ai.md#model-tiers`). */
  models?: Readonly<Partial<Record<AiModelTier, string>>> | undefined;
  /** `openai-compatible` by default. */
  transport?: AiTransportKind | undefined;
  /** Headers added to every request, e.g. those an aggregator asks for. */
  headers?: Readonly<Record<string, string>> | undefined;
}

export type AiConnection = ByokConnection;

export type AiConnectionKind = AiConnection["kind"];

/** The model of a request: its `model`, else the model of its `tier`, else the model of the connection. */
export function modelOf(
  connection: AiConnection,
  request: Pick<AiChatRequest, "model" | "tier">,
): string {
  return (
    request.model ??
    (request.tier !== undefined ? connection.models?.[request.tier] : undefined) ??
    connection.model
  );
}

/** What a transport needs of a connection, whatever its kind. */
export interface ResolvedConnection {
  baseUrl: string;
  /** Gives the bearer credential; a service connection will renew its token here. */
  credential(): Promise<string>;
  headers: Readonly<Record<string, string>>;
  transport: AiTransportKind;
}

/**
 * The headers of a call to `url`: the bearer credential, then the headers of
 * the connection. A call to `anthropic.com` also carries the header Anthropic
 * asks for before it accepts a call from a browser.
 */
export function requestHeaders(
  resolved: ResolvedConnection,
  credential: string,
  url: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${credential}`,
    ...resolved.headers,
  };
  if (/(^|\.)anthropic\.com$/i.test(new URL(url).hostname)) {
    headers["anthropic-dangerous-direct-browser-access"] = "true";
  }
  return headers;
}

export function resolveConnection(connection: AiConnection): ResolvedConnection {
  return {
    baseUrl: connection.baseUrl.replace(/\/+$/, ""),
    credential: async () => connection.apiKey,
    headers: connection.headers ?? {},
    transport: connection.transport ?? "openai-compatible",
  };
}
