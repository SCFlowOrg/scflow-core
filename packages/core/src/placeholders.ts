import { modelError } from "./errors.js";
import type { TransientValue } from "./types.js";

/**
 * ${...} placeholder resolution, per document_part-definition-placeholders.md.
 *
 * A placeholder's content is either a dot-separated path into `context`
 * (e.g. "this.name", "new_task.after.0.id") or a predefined function call
 * (e.g. "now()", "year(now())", "to_display_name(this.name)"). A path
 * segment that reaches an array is either a numeric index ("0", "1", ...)
 * selecting one entry, "*" mapping the rest of the path over every entry
 * (e.g. "new_task.after.*.id" — an array of every entry's "id"), or —
 * otherwise — resolved against entry 0 by default (e.g. "after.name" reads
 * the same as "after.0.name").
 *
 * `context` supplies whatever the caller names as path roots. Property
 * construction passes `{ this, dataset }` (see command.ts's
 * `computePropertyValue`). A script command's own `filters`/`input` are
 * resolved earlier, before any instance exists to be `this`, so those get
 * `{ dataset, ...namedResults }` (see script.ts). The special roots
 * `this.schema`, `this.instance`, `this.instance.schema` from the spec are
 * the caller's responsibility to populate into `context` shaped as plain
 * nested values — this module only walks whatever it's given.
 */

type PlaceholderFn = (...args: TransientValue[]) => TransientValue;

const FUNCTIONS: Record<string, PlaceholderFn> = {
  now: () => new Date().toISOString(),
  year: (x) => String(new Date(String(x)).getUTCFullYear()),
  month: (x) => String(new Date(String(x)).getUTCMonth() + 1),
  day: (x) => String(new Date(String(x)).getUTCDate()),
  to_display_name: (x) =>
    String(x)
      .split(/[_\s]+/)
      .filter(Boolean)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" "),
};

const PLACEHOLDER_RE = /\$\{([^}]*)\}/g;
const CALL_RE = /^([a-zA-Z_][a-zA-Z0-9_]*)\((.*)\)$/s;

function splitTopLevelArgs(argsStr: string): string[] {
  if (argsStr.trim() === "") return [];
  const args: string[] = [];
  let depth = 0;
  let quote: '"' | "'" | null = null;
  let current = "";
  for (const ch of argsStr) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if (ch === "(") {
      depth++;
      current += ch;
    } else if (ch === ")") {
      depth--;
      current += ch;
    } else if (ch === "," && depth === 0) {
      args.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim() !== "") args.push(current.trim());
  return args;
}

/** `true` for a segment that's a valid, non-negative array index — "0", "1", ..., not "", "1.5", or "-1". */
function isArrayIndex(segment: string): boolean {
  if (segment === "") return false;
  const index = Number(segment);
  return Number.isInteger(index) && index >= 0;
}

/**
 * Resolves `segments` against `current`, recursively — the array-aware part
 * of `resolvePath` below, factored out so the `*` map segment
 * (document_part-definition-placeholders.md's "Mapping over an array") can
 * recurse into "resolve the *rest* of the path against every element of an
 * array, collecting the results" without needing its own separate walker.
 * `fullPath` is just the original dotted path, carried through for error
 * messages — it never changes as segments are consumed.
 */
function resolveSegments(current: TransientValue, segments: string[], fullPath: string): TransientValue {
  if (segments.length === 0) return current;
  const [segment, ...rest] = segments;

  if (segment === "*") {
    // Map: resolve the remaining path against every element of `current`,
    // returning an array of the results — distinct from an omitted index
    // (below), which resolves against entry 0 only. `*` requires an array;
    // unlike the omitted-index default, an *empty* array is fine (maps to
    // `[]`) since there's no missing "the one entry" to fall back to.
    if (!Array.isArray(current)) {
      throw modelError("unknown_reference", `placeholder path "${fullPath}" uses "*" on a non-array value`);
    }
    return current.map((item) => resolveSegments(item, rest, fullPath));
  }

  if (Array.isArray(current)) {
    if (isArrayIndex(segment)) {
      const index = Number(segment);
      if (current[index] === undefined) {
        throw modelError("unknown_reference", `placeholder path "${fullPath}" has no index "${segment}"`);
      }
      return resolveSegments(current[index], rest, fullPath);
    }
    // `segment` isn't a numeric index or "*" — an omitted index defaults to 0
    // (document_part-definition-placeholders.md: an array path segment
    // that isn't itself an index resolves against its first element), so
    // `after.name` reads the same as `after.0.name`. `segments` (not `rest`)
    // is passed through unconsumed, so `segment` is re-processed against
    // that element next.
    if (current.length === 0) {
      throw modelError("unknown_reference", `placeholder path "${fullPath}" is empty, so "${segment}" has no default (index 0) element to resolve against`);
    }
    return resolveSegments(current[0], segments, fullPath);
  }
  if (current !== null && typeof current === "object") {
    if (!(segment in current)) {
      throw modelError("unknown_reference", `placeholder path "${fullPath}" has no property "${segment}"`);
    }
    return resolveSegments((current as { [k: string]: TransientValue })[segment], rest, fullPath);
  }
  throw modelError("unknown_reference", `placeholder path "${fullPath}" cannot descend into a scalar`);
}

function resolvePath(context: Record<string, TransientValue>, path: string[]): TransientValue {
  const [head, ...rest] = path;
  if (!(head in context)) {
    throw modelError("unknown_reference", `placeholder references unknown root "${head}"`);
  }
  return resolveSegments(context[head], rest, path.join("."));
}

function evalContent(content: string, context: Record<string, TransientValue>): TransientValue {
  const trimmed = content.trim();
  const call = CALL_RE.exec(trimmed);
  if (call) {
    const [, fnName, argsStr] = call;
    const fn = FUNCTIONS[fnName];
    if (!fn) {
      throw modelError("unknown_reference", `unknown placeholder function "${fnName}"`);
    }
    const args = splitTopLevelArgs(argsStr).map((arg) => {
      if (
        (arg.startsWith('"') && arg.endsWith('"')) ||
        (arg.startsWith("'") && arg.endsWith("'"))
      ) {
        return arg.slice(1, -1);
      }
      return evalContent(arg, context);
    });
    return fn(...args);
  }
  return resolvePath(context, trimmed.split("."));
}

function stringifyForInterpolation(value: TransientValue): string {
  if (value === null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * Resolves every ${...} in `value` (recursively through arrays/objects).
 * A string that is *entirely* one placeholder returns the resolved value
 * unconverted (so `${now()}` on a date_time property yields a string, and a
 * hypothetical placeholder resolving to a number or object round-trips as
 * such); a string with a placeholder embedded in more text interpolates it
 * as a string.
 */
export function substitutePlaceholders(
  value: TransientValue,
  context: Record<string, TransientValue>,
): TransientValue {
  if (typeof value === "string") {
    const wholeMatch = /^\$\{([^}]*)\}$/.exec(value.trim());
    if (wholeMatch) {
      return evalContent(wholeMatch[1], context);
    }
    if (!value.includes("${")) return value;
    return value.replace(PLACEHOLDER_RE, (_full, inner) =>
      stringifyForInterpolation(evalContent(inner, context)),
    );
  }
  if (Array.isArray(value)) {
    return value.map((item) => substitutePlaceholders(item, context));
  }
  if (value !== null && typeof value === "object") {
    const result: { [k: string]: TransientValue } = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = substitutePlaceholders(v, context);
    }
    return result;
  }
  return value;
}
