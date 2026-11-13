/** Every code a `DocsError` carries, each with the condition that raises it. */
export const DocsErrorCode = {
  /** A topic, its front matter or a manifest is not valid. */
  invalid_topic: "invalid_topic",
  /** An id names no topic of the catalogue (or none the caller may see). */
  not_found: "not_found",
  /** The input of the read tool is not valid. */
  invalid_parameters: "invalid_parameters",
} as const;

/** The name of one code of `DocsErrorCode`. */
export type DocsErrorCodeName = keyof typeof DocsErrorCode;

/** The error this package throws: `code` names the cause. */
export class DocsError extends Error {
  readonly code: DocsErrorCodeName;

  constructor(code: DocsErrorCodeName, message?: string) {
    super(message ?? code);
    this.name = "DocsError";
    this.code = code;
  }
}

/** Builds a `DocsError`; `message` defaults to the code. */
export function docsError(code: DocsErrorCodeName, message?: string): DocsError {
  return new DocsError(code, message);
}
