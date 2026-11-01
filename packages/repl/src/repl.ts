import { runCommandBlock } from "./commandBlock.js";
import type { LineSource, Output } from "./io.js";
import { handleMeta } from "./meta.js";
import { createReplState, currentContext } from "./state.js";
import type { ReplState } from "./state.js";

/**
 * The REPL's main input loop. Every line is a meta-command by default:
 * `run`, `new <locator> <name>`, `help`, and so on, with no marker character.
 * `run` changes what the next line means: its outcome (`"awaitRunBlock"`)
 * tells this loop to read the next line, and any that follow up to a blank
 * line, as one YAML command block, run it, and return to meta-command mode.
 * `snippet save <name>` uses the same next-block mechanism to capture the
 * block that follows it verbatim instead of running it.
 */

function promptFor(state: ReplState): string {
  const ctx = currentContext(state);
  return ctx ? `${ctx.name}> ` : "> ";
}

/** Reads lines until a blank line or EOF. `firstLine` is already consumed. */
async function readBlockLines(lines: LineSource, out: Output, firstLine: string): Promise<string[]> {
  if (firstLine.trim() === "") return [];
  const collected = [firstLine];
  for (;;) {
    out.prompt("... ");
    const line = await lines.next();
    if (line === null || line.trim() === "") break;
    collected.push(line);
  }
  return collected;
}

/**
 * Runs the input loop until `exit`, `quit` or the end of `lines`. A failed
 * command reports its error and the loop continues.
 *
 * @param initialState - used as is instead of an empty state. `cli.ts` passes
 * the same state to an `--init` pass and then to the interactive pass, so
 * whatever the first pass opened or ran is still there for the second.
 */
export async function runRepl(lines: LineSource, out: Output, initialState?: ReplState): Promise<void> {
  const state = initialState ?? createReplState();
  let pendingSnippetSave: string | null = null;
  let pendingRun = false;

  for (;;) {
    out.prompt(promptFor(state));
    const first = await lines.next();
    if (first === null) return;

    if (pendingSnippetSave) {
      const name = pendingSnippetSave;
      pendingSnippetSave = null;
      const blockLines = await readBlockLines(lines, out, first);
      state.snippets.set(name, blockLines.join("\n"));
      out.print(`(saved as $${name})`);
      continue;
    }

    if (pendingRun) {
      pendingRun = false;
      const blockLines = await readBlockLines(lines, out, first);
      await runCommandBlock(state, blockLines.join("\n"), out);
      continue;
    }

    const firstTrim = first.trim();
    if (firstTrim === "") continue;

    const outcome = await handleMeta(state, firstTrim, out);
    if (outcome === "exit") return;
    if (outcome === "awaitRunBlock") {
      pendingRun = true;
      continue;
    }
    if (outcome && typeof outcome === "object") pendingSnippetSave = outcome.awaitSnippetName;
  }
}
