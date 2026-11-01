import { ModelError } from "@scfloworg/core";

/**
 * Renders any thrown value as a one-line REPL error message: `Error [<code>]:
 * <message>` for a `ModelError`, `Error: <message>` otherwise.
 */
export function describeError(err: unknown): string {
  if (err instanceof ModelError) return `Error [${err.code}]: ${err.message}`;
  if (err instanceof Error) return `Error: ${err.message}`;
  return `Error: ${String(err)}`;
}
