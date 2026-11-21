/**
 * The reference topics of a module, generated from its declarations (Reference
 * in `docs/module-packages.md`, ADR-0014): the concepts from the descriptions
 * of its schemas and the action catalogue from its action declarations. It
 * reads no file, so a build script, a test and a browser use the same text.
 */
import type { ModuleManifest, ModuleTopic } from "@scfloworg/core";

/** A generated topic: its entry for `docs` in the manifest, and its Markdown body. */
export interface GeneratedTopic {
  topic: ModuleTopic;
  body: string;
}

type Node = Readonly<Record<string, unknown>>;
const isNode = (value: unknown): value is Node => typeof value === "object" && value !== null && !Array.isArray(value);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/**
 * The reference topics of `manifest`: the concepts (audience `user`), the names
 * when a schema declares `name_scope` (audience `user`), then the actions
 * (audience `model-dev`).
 */
export function generateReference(manifest: ModuleManifest): GeneratedTopic[] {
  const base = { kind: "reference", locale: "en", generated: true } as const;
  const actions = manifest.actions as unknown as Node[];
  const named = namedSchemas(manifest);
  const names: GeneratedTopic[] = named.length
    ? [
        {
          topic: {
            ...base,
            context: [],
            id: `${manifest.namespace}/names`,
            title: `${manifest.title}: names`,
            summary: `Which entities of ${manifest.title} are referred to by name, in what scope, and how to write a name that stays unambiguous, generated from the name_scope of ${manifest.name}.`,
            audience: "user",
            uses: [],
            file: "docs/reference/names.md",
          },
          body: renderNames(manifest, named),
        },
      ]
    : [];
  return [
    {
      topic: {
        ...base,
        context: [],
        id: `${manifest.namespace}/concepts`,
        title: `${manifest.title}: concepts`,
        summary: `The concepts of ${manifest.title} and their relations, generated from the schemas of ${manifest.name}.`,
        audience: "user",
        uses: [],
        file: "docs/reference/concepts.md",
      },
      body: renderConcepts(manifest),
    },
    ...names,
    {
      topic: {
        ...base,
        context: [],
        id: `${manifest.namespace}/actions`,
        title: `${manifest.title}: actions`,
        summary: `The actions of ${manifest.title} with their parameters and example calls, generated from the declarations of ${manifest.name}.`,
        audience: "model-dev",
        uses: actions.map((action) => String(action.id)),
        file: "docs/reference/actions.md",
      },
      body: renderActions(manifest, actions, new Set(named.map((schema) => String(schema.name)))),
    },
  ];
}

/** The schemas that declare `name_scope`, in the order of the manifest. */
function namedSchemas(manifest: ModuleManifest): Node[] {
  return (manifest.schemas as unknown as Node[]).filter((schema) => Array.isArray(schema.name_scope));
}

const GENERATED = "<!-- Generated from module.yaml by the build of the package. Do not edit. -->";

function renderConcepts(manifest: ModuleManifest): string {
  const scalars = new Map<string, Node>(
    (manifest.scalar_types as unknown as Node[]).map((scalar) => [String(scalar.name), scalar]),
  );
  const schemas = manifest.schemas as unknown as Node[];
  const lines = [GENERATED, "", `# ${manifest.title}: concepts`, ""];
  for (const schema of schemas) {
    if (schema.abstract === true) continue;
    lines.push(`### ${schema.name}`, "");
    if (typeof schema.description === "string") lines.push(`${schema.description}.`, "");
    if (typeof schema.extends === "string") lines.push(`Extends \`${schema.extends}\`.`, "");
    for (const raw of list(schema.properties)) {
      if (!isNode(raw)) continue;
      const type = String(raw.type);
      const scalar = scalars.get(type);
      const relation = schemas.some((candidate) => candidate.name === type);
      const shown = scalar && Array.isArray(scalar.enum) ? scalar.enum.join(" | ") : relation ? `→ ${type}` : type;
      const marks = [
        raw.is_array === true || raw.is_set === true ? "many" : "",
        raw.mandatory === true ? "required" : "",
        raw.owner === true ? "owner" : "",
        typeof raw.inverse_name === "string" ? `inverse \`${raw.inverse_name}\`` : "",
      ].filter(Boolean);
      lines.push(`- \`${raw.name}\`: ${shown}${marks.length ? ` (${marks.join(", ")})` : ""}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}

function renderNames(manifest: ModuleManifest, named: Node[]): string {
  const lines = [
    GENERATED,
    "",
    `# ${manifest.title}: names`,
    "",
    "A person, a script or an assistant designates an instance of these schemas by its **name**, never by its id.",
    "Give the name as short as it stays unambiguous, and never an id that you were not given.",
    "",
    "- A name is unique among the instances that share a **scope**, whatever their schema. Two instances of different scopes may have the same name.",
    "- The **qualified name** of an instance is the qualified name of its scope, ` / `, then its own name. The scope is the first relation of `name_scope` that the instance has set; when the list is empty, the scope is the dataset.",
    "- A reference is a name, or the end of a qualified name: `Line 1`, or `Lyon / Line 1` when two sites have a `Line 1`. A level of the chain may not be skipped. The spaces around `/` do not matter, and a name cannot contain `/`.",
    "- A reference that matches no instance, or several, is an error. An ambiguity error lists the qualified names of the candidates: choose one and give more of it.",
    "- A localized name may be given in any language, and is written in the source language of the project.",
    "",
    "| Schema | Name | Scope | Qualified name |",
    "| --- | --- | --- | --- |",
  ];
  for (const schema of named) {
    const scope = list(schema.name_scope).map(String);
    const property = list(schema.properties).filter(isNode).find((candidate) => candidate.name === "name");
    const kind = property?.type === "localized_string" ? "localized" : "plain text";
    const where = scope.length ? `the first of ${scope.map((relation) => `\`${relation}\``).join(", ")} that is set` : "the dataset";
    const example = scope.length ? `\`<${scope[0]}> / <${schema.name}>\`` : `\`<${schema.name}>\``;
    lines.push(`| \`${schema.name}\` | ${kind} | ${where} | ${example} |`);
  }
  lines.push("");
  return lines.join("\n").trimEnd() + "\n";
}

function renderActions(manifest: ModuleManifest, actions: Node[], named: ReadonlySet<string>): string {
  const lines = [GENERATED, "", `# ${manifest.title}: actions`, ""];
  for (const action of actions) {
    const id = String(action.id);
    lines.push(`### \`${id}\``, "");
    const flags = [
      action.kind === "read" ? "read-only" : "",
      action.destructive === true ? "destructive" : "",
      list(action.writes).length ? `writes ${list(action.writes).map((w) => `\`${w}\``).join(", ")}` : "",
    ].filter(Boolean);
    lines.push(`${action.title}. ${String(action.description ?? "").trim()}`);
    if (flags.length) lines.push("", `Flags: ${flags.join("; ")}.`);
    const parameters = isNode(action.parameters) ? action.parameters : {};
    const properties = isNode(parameters.properties) ? parameters.properties : {};
    const required = new Set(list(parameters.required).map(String));
    const names = Object.keys(properties);
    if (names.length) {
      lines.push("", "Parameters:");
      for (const name of names) {
        const schema = properties[name] as Node;
        const description = typeof schema.description === "string" ? ` ${schema.description}` : "";
        lines.push(`- \`${name}\` (${typeOf(schema, named)}${required.has(name) ? ", required" : ""}):${description}`);
      }
    }
    const minimal = Object.fromEntries(names.filter((name) => required.has(name)).map((n) => [n, sample(properties[n] as Node)]));
    const full = Object.fromEntries(names.map((n) => [n, sample(properties[n] as Node)]));
    const calls = [minimal, ...(Object.keys(full).length > Object.keys(minimal).length ? [full] : [])];
    lines.push("", "Examples:", "", "```", ...calls.map((params) => `${id} ${JSON.stringify(params)}`), "```", "");
  }
  return lines.join("\n").trimEnd() + "\n";
}

/** The subschemas of `schema` through `anyOf`, `oneOf` and `allOf`, itself first. */
function variants(schema: Node): Node[] {
  const nested = ["anyOf", "oneOf", "allOf"].flatMap((keyword) =>
    list(schema[keyword]).filter(isNode).flatMap(variants),
  );
  return [schema, ...nested];
}

function typeOf(schema: Node, named: ReadonlySet<string>): string {
  if (typeof schema.ref === "string") return named.has(schema.ref) ? `reference (name or id) of ${schema.ref}` : `id of ${schema.ref}`;
  if (Array.isArray(schema.enum)) return schema.enum.join(" | ");
  const parts = variants(schema);
  if (parts.some((part) => part.type === "string") && parts.some((part) => part.type === "object"))
    return "text or map language → text";
  if (schema.type === "array") return `list of ${isNode(schema.items) ? typeOf(schema.items, named) : "values"}`;
  return String(schema.type ?? "any");
}

/** A placeholder value of a parameter, for an example call. */
function sample(schema: Node): unknown {
  if (typeof schema.ref === "string") return `<${schema.ref}>`;
  if (Array.isArray(schema.enum)) return schema.enum[0];
  const parts = variants(schema);
  const type = schema.type ?? parts.find((part) => typeof part.type === "string")?.type;
  switch (type) {
    case "boolean":
      return true;
    case "number":
    case "integer":
      return 1;
    case "array":
      return isNode(schema.items) ? [sample(schema.items)] : [];
    case "object":
      return {};
    default:
      return "text";
  }
}
