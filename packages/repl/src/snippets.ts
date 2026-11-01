/**
 * YAML snippets: a snippet is a named chunk of raw YAML text, referenced with
 * a bare `$name` (no braces, no dots) and spliced in textually before the
 * block is parsed as a command. This is distinct from the `${...}` result
 * placeholders, which the engine resolves after parsing: a snippet is text, so
 * it has no path into a result.
 */

const BARE_REFERENCE_RE = /\$(?!\{)([a-zA-Z_][a-zA-Z0-9_]*)/g;

/**
 * Replaces every bare `$name` of `text` with the snippet saved under `name`.
 * A `${...}` placeholder is left untouched.
 *
 * @param snippets - saved snippets, keyed by name without the `$`.
 * @throws `Error` when `text` references a snippet that is not saved.
 */
export function expandSnippets(text: string, snippets: ReadonlyMap<string, string>): string {
  return text.replace(BARE_REFERENCE_RE, (full: string, name: string) => {
    const snippet = snippets.get(name);
    if (snippet === undefined) {
      throw new Error(`unknown snippet "${full}" — save it first with snippet save ${name}`);
    }
    return snippet;
  });
}
