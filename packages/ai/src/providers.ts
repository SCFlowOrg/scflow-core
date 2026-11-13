/**
 * The catalogue of providers and the list of the models of a connection (see
 * `docs/ai.md#providers`). The URLs change seldom; the model ids are
 * suggestions, since only a provider can tell what it serves today.
 */

import { requestHeaders, resolveConnection, type AiConnection } from "./connection.js";
import { AiError, errorOfAnswer } from "./errors.js";
import type { AiFetch, AiSignal } from "./types.js";

/** A provider known to accept the `openai-compatible` transport. */
export interface ProviderPreset {
  /** A short stable name. */
  id: string;
  /** The name shown to a user. */
  label: string;
  /** The `baseUrl` of a `byok` connection to it, with no trailing `/`. */
  baseUrl: string;
  /** Model ids suggested for it, the first the default; empty when only the provider can tell. */
  models: readonly string[];
  /** The page where a user gets a key. */
  keyUrl?: string | undefined;
  /** `false` for a local server, which reads no key: any non-empty text does. */
  needsKey: boolean;
}

export const PROVIDERS: readonly ProviderPreset[] = [
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    models: ["gpt-5-mini", "gpt-5"],
    keyUrl: "https://platform.openai.com/api-keys",
    needsKey: true,
  },
  {
    id: "anthropic",
    label: "Anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    models: ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"],
    keyUrl: "https://console.anthropic.com/settings/keys",
    needsKey: true,
  },
  {
    id: "mistral",
    label: "Mistral AI",
    baseUrl: "https://api.mistral.ai/v1",
    models: ["mistral-small-latest", "mistral-large-latest"],
    keyUrl: "https://console.mistral.ai/api-keys",
    needsKey: true,
  },
  {
    id: "gemini",
    label: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    models: ["gemini-2.5-flash", "gemini-2.5-pro"],
    keyUrl: "https://aistudio.google.com/apikey",
    needsKey: true,
  },
  {
    id: "groq",
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    models: ["llama-3.3-70b-versatile"],
    keyUrl: "https://console.groq.com/keys",
    needsKey: true,
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    models: [],
    keyUrl: "https://openrouter.ai/keys",
    needsKey: true,
  },
  {
    id: "ollama",
    label: "Ollama (local)",
    baseUrl: "http://localhost:11434/v1",
    models: [],
    needsKey: false,
  },
  {
    id: "lmstudio",
    label: "LM Studio (local)",
    baseUrl: "http://localhost:1234/v1",
    models: [],
    needsKey: false,
  },
];

function bare(url: string): string {
  return url.replace(/\/+$/, "");
}

/** The entry of `PROVIDERS` whose `baseUrl` is `baseUrl`, compared without a trailing `/`. */
export function providerOf(baseUrl: string): ProviderPreset | undefined {
  const wanted = bare(baseUrl);
  return PROVIDERS.find((provider) => provider.baseUrl === wanted);
}

export interface ListModelsOptions {
  /** The global `fetch` by default. */
  fetch?: AiFetch | undefined;
  signal?: AiSignal | undefined;
}

/**
 * The ids of the models a connection serves, sorted, each once:
 * `GET {baseUrl}/models` read as `{ data: [{ id }] }`.
 */
export async function listModels(
  connection: AiConnection,
  options: ListModelsOptions = {},
): Promise<string[]> {
  const { signal } = options;
  const resolved = resolveConnection(connection);
  const credential = await resolved.credential();
  if (!credential) throw new AiError("auth", "No API key is set for this connection");

  const url = `${resolved.baseUrl}/models`;
  const fetch = options.fetch ?? (globalThis as unknown as { fetch: AiFetch }).fetch;
  let response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: requestHeaders(resolved, credential, url),
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (signal?.aborted === true || (error as { name?: unknown } | null)?.name === "AbortError")
      throw error;
    throw new AiError(
      "network",
      `No answer from ${url}: ${(error as Error)?.message ?? String(error)}`,
      { cause: error },
    );
  }
  const body = await response.text().catch(() => "");
  if (!response.ok) throw errorOfAnswer(response.status, response.statusText, body, []);

  let data: unknown;
  try {
    data = (JSON.parse(body) as { data?: unknown } | null)?.data;
  } catch {
    data = undefined;
  }
  if (!Array.isArray(data))
    throw new AiError("provider", `${url} answered with no list of models`, {
      status: response.status,
    });
  const ids = data
    .map((model) => (model as { id?: unknown } | null)?.id)
    .filter((id): id is string => typeof id === "string" && id !== "");
  return [...new Set(ids)].sort();
}
