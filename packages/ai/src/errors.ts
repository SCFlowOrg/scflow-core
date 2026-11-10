/** The kinds of failure of a call to a model (see `docs/ai.md#errors`). */
export type AiErrorKind =
  | "auth"
  | "rate-limit"
  | "context-length"
  | "unsupported-parameter"
  | "model-not-found"
  | "network"
  | "provider";

/** The error of every failed call; callers branch on `kind`. The message keeps the message of the provider. */
export class AiError extends Error {
  readonly kind: AiErrorKind;
  /** The HTTP status, when the provider answered. */
  readonly status: number | undefined;
  /** The refused parameter, for `unsupported-parameter`. */
  readonly parameter: string | undefined;

  constructor(
    kind: AiErrorKind,
    message: string,
    options: { status?: number; parameter?: string; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AiError";
    this.kind = kind;
    this.status = options.status;
    this.parameter = options.parameter;
  }
}

/** What a provider says about an error, read from its body. */
export interface ProviderError {
  message: string;
  code?: string;
  type?: string;
  param?: string;
}

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value !== ""
    ? value
    : typeof value === "number"
      ? String(value)
      : undefined;

/** Reads `{ error: { message, code, type, param } }` or `{ error: "…" }`, else keeps the raw body. */
export function readProviderError(body: string): ProviderError {
  try {
    const parsed = JSON.parse(body) as { error?: unknown; message?: unknown };
    const error = parsed.error;
    if (typeof error === "string" && error) return { message: error };
    if (error && typeof error === "object") {
      const fields = error as Record<string, unknown>;
      const message = text(fields.message) ?? body;
      const read: ProviderError = { message };
      const code = text(fields.code);
      const type = text(fields.type);
      const param = text(fields.param);
      if (code) read.code = code;
      if (type) read.type = type;
      if (param) read.param = param;
      return read;
    }
    if (typeof parsed.message === "string") return { message: parsed.message };
  } catch {
    // Not JSON: the raw body.
  }
  return { message: body.slice(0, 400) };
}

const CONTEXT =
  /context[_ ]length|maximum context|context window|too many tokens|prompt is too long|reduce the length/i;
const MODEL =
  /model.*(not found|does not exist|not exist|unknown|invalid model)|no such model|unknown model/i;
const UNSUPPORTED =
  /unsupported|not supported|does not support|unrecognized|unknown (parameter|field|argument)|not permitted|not allowed/i;

/**
 * The error of a failed answer. `sent` lists the optional parameters of the
 * request: one of them named by the provider makes an `unsupported-parameter`.
 */
export function errorOfAnswer(
  status: number,
  statusText: string,
  body: string,
  sent: readonly string[],
): AiError {
  const provider = readProviderError(body);
  const head = `${status}${statusText ? ` ${statusText}` : ""}`;
  const message = provider.message ? `${head}: ${provider.message}` : head;
  const code = `${provider.code ?? ""} ${provider.type ?? ""}`;
  const options = { status };

  if (status === 401 || status === 403 || /invalid_api_key|authentication/i.test(code)) {
    return new AiError("auth", message, options);
  }
  if (status === 429 || /rate_limit|insufficient_quota/i.test(code))
    return new AiError("rate-limit", message, options);
  if (/context_length/i.test(code) || CONTEXT.test(provider.message)) {
    return new AiError("context-length", message, options);
  }
  if (/model_not_found/i.test(code) || (status === 404 && MODEL.test(provider.message))) {
    return new AiError("model-not-found", message, options);
  }
  if (status === 400 || status === 422) {
    const parameter = refusedParameter(provider, sent);
    if (parameter) return new AiError("unsupported-parameter", message, { status, parameter });
  }
  if (status === 404) return new AiError("model-not-found", message, options);
  return new AiError("provider", message, options);
}

function refusedParameter(provider: ProviderError, sent: readonly string[]): string | undefined {
  const refused =
    /unsupported_(parameter|value)/i.test(provider.code ?? "") ||
    UNSUPPORTED.test(provider.message);
  if (!refused) return undefined;
  if (provider.param && sent.includes(provider.param)) return provider.param;
  return sent.find((name) => new RegExp(`\\b${name}\\b`).test(provider.message));
}
