import { collectExtendingSchemas } from "./command.js";
import { modelError } from "./errors.js";
import { isFacet } from "./facets.js";
import { isUuid } from "./ids.js";
import { resolveLocalizedText } from "./languages.js";
import type { Resolvers } from "./resolvers.js";
import { importNamespaceOf } from "./resolvers.js";
import { NAME_SEPARATOR, hasNameScope, isEmbedded, nameScopeOf } from "./schema.js";
import { derivePropertyRoles } from "./schemaProcessing.js";
import type { Key, NormalizedSchema, PersistenceInterface, TransientObject, TransientValue } from "./types.js";

/**
 * Names, scopes and references, per packages/core/docs/spec/meta-model.md#names-and-references.
 *
 * A schema with the constraint `name_scope` is referred to by `name`. The
 * instances of such schemas, read once into a `NamedInstances` index, give the
 * three things the specification defines: the uniqueness of a name in its
 * scope (`nameBreaches`, checked by the rules at the end of a transaction),
 * the qualified name of an instance, and the resolution of a reference, an id
 * or a possibly shortened qualified name, to one instance (`matchReference`).
 */

/** One instance of a schema with `name_scope`, as the index holds it. */
export interface NamedInstance {
  schema: string;
  key: Key;
  /** The topmost schema of the `extends` chain that declares `name_scope`: names are unique within a family. */
  family: string;
  /** The texts of the name, every language, trimmed; one for a `string`. */
  names: string[];
  /** The name as stored: a text, or a map of language to text. */
  name: TransientValue;
  /** The key of the scope, the first relation of `name_scope` the instance has set; `null` when the scope is the dataset. */
  scope: Key | null;
  /** An imported instance is read, never at fault. */
  imported: boolean;
}

/** Every instance of a schema with `name_scope`, by key. */
export type NamedInstances = Map<Key, NamedInstance>;

/** The texts of a name: the text of a `string`, every text of a map, trimmed, empty ones left out. */
export function textsOfName(name: TransientValue | undefined): string[] {
  const raw = typeof name === "string" ? [name] : name !== null && typeof name === "object" && !Array.isArray(name) ? Object.values(name as TransientObject) : [];
  return raw.filter((t): t is string => typeof t === "string").map((t) => t.trim()).filter((t) => t !== "");
}

/** The text of a name to show: `languages` first, else the first text. */
export function labelOfName(name: TransientValue | undefined, languages: readonly string[] = []): string {
  if (typeof name === "string") return name.trim();
  if (name !== null && typeof name === "object" && !Array.isArray(name)) {
    const map = name as Record<string, string>;
    for (const language of languages) {
      const text = resolveLocalizedText(map, [language], language);
      if (text !== undefined && text.trim() !== "") return text.trim();
    }
    return textsOfName(name)[0] ?? "";
  }
  return "";
}

/** The topmost schema of the `extends` chain of `schema` that declares `name_scope`. */
function familyOf(schema: NormalizedSchema, resolvers: Resolvers): string {
  let current = schema;
  while (current.extends) {
    const parent = resolvers.schemas.get(current.extends);
    if (!parent || !hasNameScope(parent)) break;
    current = parent;
  }
  return current.name;
}

/** The schemas with `name_scope` that hold instances: stored, not abstract, not facets. */
export function namedSchemas(resolvers: Resolvers): NormalizedSchema[] {
  return [...resolvers.schemas.values()].filter((s) => hasNameScope(s) && !isEmbedded(s) && !isFacet(s) && s.constraints.abstract !== true);
}

/** Reads every instance of every schema with `name_scope`. Reads only. */
export async function loadNamedInstances(impl: PersistenceInterface, rest: string, resolvers: Resolvers): Promise<NamedInstances> {
  const all: NamedInstances = new Map();
  const namespaces = resolvers.importNamespaces ?? [];
  for (const schema of namedSchemas(resolvers)) {
    const family = familyOf(schema, resolvers);
    const relations = nameScopeOf(schema);
    for (const raw of (await impl.listInstances(rest, schema.name, derivePropertyRoles(schema))) as TransientObject[]) {
      const key = raw.id;
      if (typeof key !== "string") continue;
      let scope: Key | null = null;
      for (const relation of relations) {
        const value = raw[relation];
        if (typeof value === "string" && value !== "") {
          scope = value;
          break;
        }
      }
      all.set(key, { schema: schema.name, key, family, names: textsOfName(raw.name), name: raw.name, scope, imported: importNamespaceOf(key, namespaces) !== undefined });
    }
  }
  return all;
}

/** The instances from the root scope down to `instance`, itself last. A scope missing from the index, or a loop, ends the chain. */
export function chainOf(instance: NamedInstance, all: NamedInstances): NamedInstance[] {
  const chain = [instance];
  const seen = new Set<Key>([instance.key]);
  let scope = instance.scope;
  while (scope !== null && !seen.has(scope)) {
    const parent = all.get(scope);
    if (!parent) break;
    chain.unshift(parent);
    seen.add(scope);
    scope = parent.scope;
  }
  return chain;
}

/** The qualified name of `instance`: the names of its scopes and its own, joined by ` / `; each name in the first of `languages` that has one. */
export function qualifiedName(instance: NamedInstance, all: NamedInstances, languages: readonly string[] = []): string {
  return chainOf(instance, all).map((i) => labelOfName(i.name, languages)).join(` ${NAME_SEPARATOR} `);
}

/** The segments of a written reference: split on `/`, trimmed. */
export function splitReference(text: string): string[] {
  return text.split(NAME_SEPARATOR).map((segment) => segment.trim());
}

/**
 * The instances a written reference designates: the one whose key is the text
 * when the text is a uuid and some instance has it, else those whose
 * qualified name ends with the segments of the text, each segment compared
 * with every text of that name, exactly and case-sensitively. `accept` keeps
 * the candidates of the schema the reference is for.
 */
export function matchReference(all: NamedInstances, text: string, accept: (instance: NamedInstance) => boolean = () => true): NamedInstance[] {
  const trimmed = text.trim();
  if (isUuid(trimmed)) {
    const byId = all.get(trimmed);
    if (byId && accept(byId)) return [byId];
  }
  const segments = splitReference(trimmed);
  if (segments.some((s) => s === "")) return [];
  const found: NamedInstance[] = [];
  for (const candidate of all.values()) {
    if (!accept(candidate)) continue;
    const chain = chainOf(candidate, all);
    if (chain.length < segments.length) continue;
    const offset = chain.length - segments.length;
    if (segments.every((segment, i) => chain[offset + i].names.includes(segment))) found.push(candidate);
  }
  return found;
}

/** Options of a resolution: `schema` keeps the candidates of that schema and its descendants; `languages` writes the candidates of an error. */
export interface ResolveOptions {
  schema?: string;
  languages?: readonly string[];
}

/**
 * Resolves a reference, an id or a name, to one instance of a schema with
 * `name_scope`. A name is as short as it stays unambiguous, `Line 1`, or
 * `Lyon / Line 1`, a suffix of the qualified name. One match resolves; no
 * match is `unresolved_reference`; several are `ambiguous_reference`, which
 * lists the qualified names of the candidates in its message and in
 * `details.candidates`.
 */
export function resolveReferenceIn(all: NamedInstances, resolvers: Resolvers, text: string, options: ResolveOptions = {}): { schema: string; key: Key } {
  const target = options.schema !== undefined ? resolvers.schemas.get(options.schema) : undefined;
  if (options.schema !== undefined && !target) throw modelError("unknown_schema", `no schema "${options.schema}"`);
  const family = target ? new Set(collectExtendingSchemas(target, resolvers).map((s) => s.name)) : undefined;
  const found = matchReference(all, text, (i) => family === undefined || family.has(i.schema));
  const wording = options.schema !== undefined ? ` of "${options.schema}"` : "";
  if (found.length === 0) throw modelError("unresolved_reference", `"${text}" designates no instance${wording}`, { reference: text });
  if (found.length > 1) {
    const candidates = found.map((i) => qualifiedName(i, all, options.languages ?? [])).sort();
    throw modelError("ambiguous_reference", `"${text}" designates ${found.length} instances${wording}: ${candidates.map((c) => `"${c}"`).join(", ")}; give more of the qualified name`, { reference: text, candidates });
  }
  return { schema: found[0].schema, key: found[0].key };
}

/** Resolves a reference against the dataset at `rest`, see `resolveReferenceIn`. */
export async function resolveReference(impl: PersistenceInterface, rest: string, resolvers: Resolvers, text: string, options: ResolveOptions = {}): Promise<{ schema: string; key: Key }> {
  return resolveReferenceIn(await loadNamedInstances(impl, rest, resolvers), resolvers, text, options);
}

/** What an export writes for an instance: the shortest unambiguous reference now, and the full path. */
export interface ReferenceOf {
  reference: string;
  full: string;
}

/**
 * The shortest suffix of the qualified name of `key` that designates it alone
 * in the dataset now, and the full qualified name. Both are written in the
 * first of `languages` that has a text. A name another language of which
 * another instance bears is ambiguous too, so the answer is checked with
 * `matchReference` itself. The full path is returned when no suffix is
 * unambiguous, which only two instances with the same qualified name allow.
 */
export function referenceOfIn(all: NamedInstances, key: Key, languages: readonly string[] = []): ReferenceOf {
  const instance = all.get(key);
  if (!instance) throw modelError("unresolved_reference", `no instance with the id "${key}" has a name`, { reference: key });
  const labels = chainOf(instance, all).map((i) => labelOfName(i.name, languages));
  const full = labels.join(` ${NAME_SEPARATOR} `);
  for (let n = 1; n <= labels.length; n++) {
    const candidate = labels.slice(labels.length - n).join(` ${NAME_SEPARATOR} `);
    const found = matchReference(all, candidate);
    if (found.length === 1 && found[0].key === key) return { reference: candidate, full };
  }
  return { reference: full, full };
}

/** `referenceOfIn` against the dataset at `rest`. */
export async function referenceOf(impl: PersistenceInterface, rest: string, resolvers: Resolvers, key: Key, languages: readonly string[] = []): Promise<ReferenceOf> {
  return referenceOfIn(await loadNamedInstances(impl, rest, resolvers), key, languages);
}

/** One breach of the uniqueness of names, as `evaluateRules` reports it. */
export interface NameBreach {
  schema: string;
  key: Key;
  message: string;
}

/**
 * The breaches of the uniqueness of names: two instances of one family that
 * share a scope and a text of their names, in any language, compared exactly
 * after trimming. `written` restricts the instances at fault to those a
 * transaction wrote; an imported instance is never at fault.
 */
export function nameBreaches(all: NamedInstances, written: ReadonlySet<Key> | "all", languages: readonly string[] = []): NameBreach[] {
  const groups = new Map<string, NamedInstance[]>();
  for (const instance of all.values()) {
    const id = `${instance.family}\u0000${instance.scope ?? ""}`;
    const group = groups.get(id);
    if (group) group.push(instance);
    else groups.set(id, [instance]);
  }
  const breaches: NameBreach[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    for (const instance of group) {
      if (instance.imported || (written !== "all" && !written.has(instance.key))) continue;
      const others = group.filter((o) => o.key !== instance.key && o.names.some((t) => instance.names.includes(t)));
      if (others.length === 0) continue;
      const shared = instance.names.find((t) => others.some((o) => o.names.includes(t))) as string;
      const scope = instance.scope !== null && all.get(instance.scope) ? `"${qualifiedName(all.get(instance.scope) as NamedInstance, all, languages)}"` : "the dataset";
      const who = [instance, ...others].map((i) => `"${i.schema}" ${i.key}`).join(", ");
      breaches.push({ schema: instance.schema, key: instance.key, message: `"${instance.key}" of "${instance.schema}" breaks the rule "name_scope": the name "${shared}" is also used in the scope ${scope} by ${others.length === 1 ? "another instance" : `${others.length} other instances`} (${who})` });
    }
  }
  return breaches;
}
