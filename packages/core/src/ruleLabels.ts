import { keyOf } from "./command.js";
import { labelOfName, qualifiedName } from "./names.js";
import type { NamedInstances } from "./names.js";
import type { Resolvers } from "./resolvers.js";
import { findProperty, hasNameScope } from "./schema.js";
import { resolveType } from "./schemaProcessing.js";
import type { Key, NormalizedSchema, TransientObject } from "./types.js";

/**
 * How a refusal names an instance, per
 * packages/core/docs/spec/meta-model.md#rules. A refusal rolls back what the
 * transaction wrote, so an instance is named by what survives: its qualified
 * name with `name_scope`, else its `name`, else what its single-valued
 * relations link, and its key only when it has none of these.
 */

/** What naming an instance reads. Both reads only happen once a rule is broken. */
export interface LabelSource {
  resolvers: Resolvers;
  named: () => Promise<NamedInstances>;
  listFamily: (root: NormalizedSchema) => Promise<{ schema: NormalizedSchema; instance: TransientObject }[]>;
}

/** The relations followed in turn from an instance without a name; further ones are named by their key. */
const DEPTH = 3;

/** The name of an instance, qualified with `name_scope`; `undefined` when it has none. */
async function nameOf(source: LabelSource, schema: NormalizedSchema, instance: TransientObject): Promise<string | undefined> {
  if (hasNameScope(schema)) {
    const all = await source.named();
    const found = all.get(keyOf(schema, instance));
    if (found) return qualifiedName(found, all) || undefined;
  }
  return labelOfName(instance.name) || undefined;
}

/** What the single-valued relations of an instance link, `source "Plant", item "Pill"`, in the order of the schema; empty when they link nothing. */
async function linksOf(source: LabelSource, schema: NormalizedSchema, instance: TransientObject, depth: number): Promise<string> {
  const links: string[] = [];
  for (const { name } of schema.properties) {
    const prop = findProperty(schema, name);
    const value = instance[name];
    if (!prop || prop.constraints.__generated === true || prop.constraints.is_array === true || typeof value !== "string") continue;
    const resolved = resolveType(prop.type, source.resolvers.ctx);
    if (resolved.kind !== "relation") continue;
    links.push(`${name} ${await targetLabel(source, resolved.schema, value, depth - 1)}`);
  }
  return links.join(", ");
}

async function targetLabel(source: LabelSource, target: NormalizedSchema, key: Key, depth: number): Promise<string> {
  const found = (await source.listFamily(target)).find((c) => keyOf(c.schema, c.instance) === key);
  if (!found) return `"${key}"`;
  const name = await nameOf(source, found.schema, found.instance);
  if (name !== undefined) return `"${name}"`;
  const links = depth > 0 ? await linksOf(source, found.schema, found.instance, depth) : "";
  return links === "" ? `"${key}"` : `(${links})`;
}

/** The instance at fault as the subject of a refusal: `"Plant" of "actor"`, or `the "flow" with source "Plant", destination "Pharmacy"`. */
export async function subjectOf(source: LabelSource, schema: NormalizedSchema, instance: TransientObject): Promise<string> {
  const name = await nameOf(source, schema, instance);
  if (name !== undefined) return `"${name}" of "${schema.name}"`;
  const links = await linksOf(source, schema, instance, DEPTH);
  return links === "" ? `"${keyOf(schema, instance)}" of "${schema.name}"` : `the "${schema.name}" with ${links}`;
}
