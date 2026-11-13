import { createEngine } from "@scfloworg/core";
import { describe, expect, it } from "vitest";
import { createReplState, currentContext, expandSnippets } from "../src/index.js";

// A minimal sanity check on the package's public surface; the behavioral
// coverage is in tests/repl.test.ts.
describe("@scfloworg/cli exports", () => {
  it("createReplState starts with no current dataset and no snippets", () => {
    const state = createReplState({ engine: createEngine({ formats: [] }) });
    expect(currentContext(state)).toBeNull();
    expect(state.contexts.size).toBe(0);
    expect(state.snippets.size).toBe(0);
  });

  it("expandSnippets leaves ${...} placeholders untouched", () => {
    const snippets = new Map([["foo", "bar: 1"]]);
    expect(expandSnippets("a: $foo\nb: ${result.after.0.id}", snippets)).toBe("a: bar: 1\nb: ${result.after.0.id}");
  });
});
