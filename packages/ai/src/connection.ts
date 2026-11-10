/**
 * The connections a request goes through (see `docs/ai.md#connections`).
 * `byok` is the only kind today; a service connection will be a second member
 * of `AiConnection`, so hosts write their code against the union.
 */

/** How to talk to a connection. */
export type AiTransportKind = "openai-compatible";

/** The user's own key, sent straight to the provider. */
export interface ByokConnection {
  kind: "byok";
  /** Base URL of the API, e.g. `https://api.openai.com/v1`. */
  baseUrl: string;
  apiKey: string;
  /** The model used when a request names none. */
  model: string;
  /** `openai-compatible` by default. */
  transport?: AiTransportKind | undefined;
  /** Headers added to every request, e.g. those an aggregator asks for. */
  headers?: Readonly<Record<string, string>> | undefined;
}

export type AiConnection = ByokConnection;

export type AiConnectionKind = AiConnection["kind"];

/** What a transport needs of a connection, whatever its kind. */
export interface ResolvedConnection {
  baseUrl: string;
  /** Gives the bearer credential; a service connection will renew its token here. */
  credential(): Promise<string>;
  headers: Readonly<Record<string, string>>;
  transport: AiTransportKind;
}

export function resolveConnection(connection: AiConnection): ResolvedConnection {
  return {
    baseUrl: connection.baseUrl.replace(/\/+$/, ""),
    credential: async () => connection.apiKey,
    headers: connection.headers ?? {},
    transport: connection.transport ?? "openai-compatible",
  };
}
