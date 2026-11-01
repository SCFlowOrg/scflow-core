import { describe, expect, it } from "vitest";
import { substitutePlaceholders } from "../src/placeholders.js";

describe("substitutePlaceholders", () => {
  it("leaves plain strings untouched", () => {
    expect(substitutePlaceholders("hello", {})).toBe("hello");
  });

  it("resolves now() to an ISO timestamp", () => {
    const result = substitutePlaceholders("${now()}", {});
    expect(typeof result).toBe("string");
    expect(() => new Date(result as string).toISOString()).not.toThrow();
  });

  it("resolves a dotted path against context", () => {
    const context = { this: { name: "alice", nested: { email: "alice@example.com" } } };
    expect(substitutePlaceholders("${this.name}", context)).toBe("alice");
    expect(substitutePlaceholders("${this.nested.email}", context)).toBe("alice@example.com");
  });

  it("navigates array indices for script results", () => {
    const context = { new_task: { after: [{ id: "t4" }] } };
    expect(substitutePlaceholders("${new_task.after.0.id}", context)).toBe("t4");
  });

  it("resolves to_display_name()", () => {
    expect(substitutePlaceholders('${to_display_name("properties_constraint")}', {})).toBe("Properties Constraint");
  });

  it("interpolates a placeholder embedded in more text as a string", () => {
    const context = { this: { name: "alice" } };
    expect(substitutePlaceholders("Hello, ${this.name}!", context)).toBe("Hello, alice!");
  });

  it("throws unknown_reference for an unresolvable root", () => {
    expect(() => substitutePlaceholders("${missing.path}", {})).toThrow(/unknown_reference|missing/);
  });

  it("defaults an omitted array index to 0", () => {
    const context = {
      new_task: {
        after: [
          { id: "t4", name: "first" },
          { id: "t5", name: "second" },
        ],
      },
    };
    expect(substitutePlaceholders("${new_task.after.name}", context)).toBe("first");
    expect(substitutePlaceholders("${new_task.after.0.name}", context)).toBe("first");
    // an explicit index still works, and isn't affected by the default
    expect(substitutePlaceholders("${new_task.after.1.name}", context)).toBe("second");
    // a path that ends exactly at the array (no further segment) still returns the whole array
    expect(substitutePlaceholders("${new_task.after}", context)).toEqual(context.new_task.after);
  });

  it("cascades the array-index default through nested arrays", () => {
    const context = { grid: { rows: [[{ cell: "a1" }, { cell: "a2" }], [{ cell: "b1" }]] } };
    expect(substitutePlaceholders("${grid.rows.cell}", context)).toBe("a1");
  });

  it("throws unknown_reference defaulting into an empty array", () => {
    expect(() => substitutePlaceholders("${result.after.name}", { result: { after: [] } })).toThrow(/unknown_reference|empty/);
  });

  it("maps the rest of the path over every array element with *", () => {
    const context = {
      p: [{ name: "alice" }, { name: "bob" }, { name: "carol" }],
    };
    expect(substitutePlaceholders("${p.*.name}", context)).toEqual(["alice", "bob", "carol"]);
    // an explicit index still selects one entry, unaffected by *
    expect(substitutePlaceholders("${p.1.name}", context)).toBe("bob");
    // an omitted index still defaults to 0, unaffected by * — the two are separate syntaxes
    expect(substitutePlaceholders("${p.name}", context)).toBe("alice");
  });

  it("* on an empty array maps to an empty array, unlike the omitted-index default", () => {
    expect(substitutePlaceholders("${p.*.name}", { p: [] })).toEqual([]);
  });

  it("* cascades through nested arrays, one map per *", () => {
    const context = { grid: { rows: [[{ cell: "a1" }, { cell: "a2" }], [{ cell: "b1" }]] } };
    expect(substitutePlaceholders("${grid.rows.*.*.cell}", context)).toEqual([["a1", "a2"], ["b1"]]);
  });

  it("throws unknown_reference when * is used on a non-array value", () => {
    expect(() => substitutePlaceholders("${this.name.*}", { this: { name: "alice" } })).toThrow(/unknown_reference|non-array/);
  });

  it("a placeholder that's entirely a *-mapped path round-trips as an array, not a string", () => {
    const context = { p: [{ n: 1 }, { n: 2 }] };
    const result = substitutePlaceholders("${p.*.n}", context);
    expect(Array.isArray(result)).toBe(true);
    expect(result).toEqual([1, 2]);
  });

  it("recurses through arrays and objects", () => {
    const context = { this: { name: "bob" } };
    const value = { greeting: "hi ${this.name}", tags: ["${this.name}", "static"] };
    expect(substitutePlaceholders(value, context)).toEqual({
      greeting: "hi bob",
      tags: ["bob", "static"],
    });
  });
});
