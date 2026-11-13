/**
 * The I/O abstraction the REPL loop (`repl.ts`) is written against, so it runs
 * either over real stdin and stdout (`cli.ts`) or over an in-memory line array
 * and captured output (the tests) with no conditional logic in the loop.
 */

/** A source of input lines. */
export interface LineSource {
  /** The next input line, or `null` at end of input. */
  next(): Promise<string | null>;
}

/** A destination for the REPL's output. */
export interface Output {
  print(text: string): void;
  printError(text: string): void;
  /** Shows `text` as the prompt for the next line to be read. A no-op is fine for non-interactive output. */
  prompt(text: string): void;
}
