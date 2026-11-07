/**
 * The bundle check: the first level of the contract of a body, run at build and
 * before `modules.load` imports a bundle (see `docs/module-packages.md`, Check
 * the bundle). It is fast, and a static analysis proves nothing alone.
 */
import { parse } from "acorn";
import { analyze } from "eslint-scope";
import type { Node, Program } from "estree";

/** The rule a breach of the bundle check breaks. */
export type BundleRule =
  | "import"
  | "dynamic_import"
  | "import_meta"
  | "export"
  | "no_default_export"
  | "forbidden_global"
  | "global"
  | "random";

/** One breach of the bundle check. */
export interface BundleFinding {
  readonly rule: BundleRule;
  readonly message: string;
  /** The line of the breach, from 1, when it has one. */
  readonly line?: number;
}

/**
 * The globals a bundle may use: the parts of ECMAScript that read nothing of the
 * host. `Math` is allowed without `random`, which the check refuses on its own.
 */
export const ALLOWED_GLOBALS: ReadonlySet<string> = new Set([
  "undefined",
  "NaN",
  "Infinity",
  "isFinite",
  "isNaN",
  "parseFloat",
  "parseInt",
  "encodeURI",
  "encodeURIComponent",
  "decodeURI",
  "decodeURIComponent",
  "Object",
  "Array",
  "String",
  "Number",
  "Boolean",
  "Symbol",
  "BigInt",
  "Math",
  "JSON",
  "RegExp",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "Promise",
  "Reflect",
  "Proxy",
  "Iterator",
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "EvalError",
  "URIError",
  "AggregateError",
  "ArrayBuffer",
  "DataView",
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
]);

/** The globals that run text as code. */
const FORBIDDEN_GLOBALS: ReadonlySet<string> = new Set(["eval", "Function"]);

type Located = Node & { loc?: { start: { line: number } } | null };

const lineOf = (node: Node): number | undefined => (node as Located).loc?.start.line;

/** Visits every node of a tree, in source order. */
function walk(node: Node, visit: (node: Node) => void): void {
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "range") continue;
    const value = (node as unknown as Record<string, unknown>)[key];
    const children = Array.isArray(value) ? value : [value];
    for (const child of children) {
      if (child && typeof child === "object" && typeof (child as Node).type === "string") walk(child as Node, visit);
    }
  }
}

/**
 * Checks the code of a bundle and returns its breaches, empty for a bundle that
 * passes. A bundle is one ES module whose only export is the default one, with
 * no import, no dynamic import, no `import.meta`, no `eval` or `Function`, no
 * `Math.random`, and no free name other than an allowed global. Code that does
 * not parse throws the error of the parser.
 */
export function checkBundle(code: string): BundleFinding[] {
  const program = parse(code, { ecmaVersion: "latest", sourceType: "module", locations: true, ranges: true }) as unknown as Program;
  const findings: BundleFinding[] = [];
  const add = (rule: BundleRule, message: string, node?: Node) => {
    const line = node ? lineOf(node) : undefined;
    findings.push(line === undefined ? { rule, message } : { rule, message, line });
  };

  let defaults = 0;
  for (const statement of program.body) {
    switch (statement.type) {
      case "ImportDeclaration":
        add("import", `the bundle imports "${String(statement.source.value)}"`, statement);
        break;
      case "ExportAllDeclaration":
        add("import", `the bundle re-exports "${String(statement.source.value)}"`, statement);
        break;
      case "ExportDefaultDeclaration":
        defaults += 1;
        break;
      case "ExportNamedDeclaration": {
        if (statement.source) {
          add("import", `the bundle re-exports "${String(statement.source.value)}"`, statement);
          break;
        }
        const others = statement.declaration
          ? ["a declaration"]
          : statement.specifiers
              .map((specifier) =>
                specifier.exported.type === "Identifier" ? specifier.exported.name : String(specifier.exported.value),
              )
              .filter((name) => {
                if (name !== "default") return true;
                defaults += 1;
                return false;
              });
        if (others.length > 0)
          add("export", `the bundle exports ${others.join(", ")}: its only export is the default one`, statement);
        break;
      }
    }
  }
  if (defaults === 0) add("no_default_export", "the bundle has no default export");

  walk(program, (node) => {
    if (node.type === "ImportExpression") add("dynamic_import", "the bundle uses a dynamic import", node);
    else if (node.type === "MetaProperty" && node.meta.name === "import")
      add("import_meta", "the bundle reads import.meta", node);
    else if (
      node.type === "MemberExpression" &&
      node.object.type === "Identifier" &&
      node.object.name === "Math" &&
      ((!node.computed && node.property.type === "Identifier" && node.property.name === "random") ||
        (node.computed && node.property.type === "Literal" && node.property.value === "random"))
    )
      add("random", "the bundle reads Math.random: ids come from MCL", node);
  });

  const scope = analyze(program, { ecmaVersion: 2022, sourceType: "module" }).globalScope;
  for (const reference of scope?.through ?? []) {
    const name = reference.identifier.name;
    if (FORBIDDEN_GLOBALS.has(name)) add("forbidden_global", `the bundle uses ${name}`, reference.identifier);
    else if (!ALLOWED_GLOBALS.has(name))
      add("global", `the bundle uses the global ${name}, which is not allowed`, reference.identifier);
  }

  return findings.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
}

/** The breaches as one message, one per line. */
export function formatFindings(findings: readonly BundleFinding[]): string {
  return findings.map((f) => (f.line === undefined ? `- ${f.message}` : `- line ${f.line}: ${f.message}`)).join("\n");
}
