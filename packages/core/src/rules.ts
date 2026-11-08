import { clone, collectExtendingSchemas, isSchemaOrDescendant, keyOf, resolveVirtualProperties } from "./command.js";
import { modelError } from "./errors.js";
import { isFacet } from "./facets.js";
import { matchFilter, operandPath, valueOnPath } from "./filter.js";
import type { FilterEvalContext } from "./filter.js";
import { isModelSchema } from "./modelUpgrade.js";
import { checksOf, uniqueGroupsOf } from "./ruleDeclarations.js";
import type { CheckRule } from "./ruleDeclarations.js";
import { EACH, hasRules, thisPath } from "./ruleValidation.js";
import type { Resolvers } from "./resolvers.js";
import { importNamespaceOf } from "./resolvers.js";
import { findProperty, keyPropertyName } from "./schema.js";
import { derivePropertyRoles, resolveType } from "./schemaProcessing.js";
import type { Key, NormalizedSchema, PersistenceInterface, TransientObject, TransientValue } from "./types.js";

/**
 * Declared rules, per packages/core/docs/spec/meta-model.md#rules: `checks`
 * (`require` and `exists`), `unique` and `acyclic`. They only refuse. The
 * engine evaluates them at the end of a transaction, in its prepare phase,
 * on the instances the transaction wrote and on those whose rules read a path
 * that changed (`evaluateRules` with the delta), and on every instance after
 * an upgrade (`evaluateRules` with `"all"`). A breach is reported as a
 * `RuleViolation`, which `ruleViolationError` turns into `rule_violation`.
 *
 * `set_once` and `on_delete` are checked by the command itself (command.ts),
 * since each concerns one write.
 */

/** One breach of a rule: its name, the schema that declares it and the key of the instance at fault. */
export interface RuleViolation {
  rule: string;
  schema: string;
  key: Key;
  message: string;
}

/** One instance a transaction touched: `after` is `undefined` for a deleted one. */
export interface TouchedInstance {
  schema: string;
  key: Key;
  after: TransientValue | undefined;
}


/** The schemas whose instances rules apply to: stored data schemas, neither facets nor the meta-model. */
function ruledSchemas(resolvers: Resolvers): NormalizedSchema[] {
  return [...resolvers.schemas.values()].filter(
    (s) => keyPropertyName(s) !== null && !isFacet(s) && !isModelSchema(s.name) && s.name !== "dataset" && s.name !== "import" && hasRules(s),
  );
}

/** Whether the model declares any rule on a schema with instances: without one, nothing needs capturing. */
export function modelHasRules(resolvers: Resolvers): boolean {
  return ruledSchemas(resolvers).length > 0;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/** The schemas a check reads through its paths, and the schema of its `exists`: a change to one of their instances re-evaluates it. */
function dependencies(schema: NormalizedSchema, check: CheckRule, resolvers: Resolvers): string[] {
  const found = new Set<string>();
  const follow = (path: string[]) => {
    let current: NormalizedSchema | undefined = schema;
    for (const segment of path) {
      const prop = current ? findProperty(current, segment) : undefined;
      if (!prop) return;
      let next: NormalizedSchema | undefined;
      try {
        const resolved = resolveType(prop.type, resolvers.ctx);
        next = resolved.kind === "relation" ? resolved.schema : undefined;
      } catch {
        next = undefined;
      }
      if (!next) return;
      found.add(next.name);
      current = next;
    }
  };
  const walkFilter = (filter: unknown) => {
    if (filter === null || typeof filter !== "object" || Array.isArray(filter)) return;
    for (const [key, value] of Object.entries(filter as TransientObject)) {
      if (key === "and" || key === "or") {
        for (const sub of (value as TransientValue[]) ?? []) walkFilter(sub);
        continue;
      }
      if (key === "not") {
        walkFilter(value);
        continue;
      }
      follow(key.split("."));
      const operands = value !== null && typeof value === "object" && !Array.isArray(value) ? Object.values(value as TransientObject) : [value];
      for (const operand of operands) {
        const path = typeof operand === "string" ? safeOperandPath(operand) : undefined;
        if (path) follow(path);
      }
    }
  };
  walkFilter(check.when);
  walkFilter(check.require);
  if (check.exists) {
    found.add(check.exists.schema);
    const values: TransientValue[] = [...Object.values(check.exists.with), ...(Array.isArray(check.each) ? check.each : check.each !== undefined ? [check.each] : [])];
    for (const value of values) {
      const path = thisPath(value);
      if (path) follow(path);
    }
  }
  return [...found];
}

function safeOperandPath(operand: string): string[] | undefined {
  try {
    return operandPath(operand);
  } catch {
    return undefined;
  }
}

function sameValue(a: TransientValue | undefined, b: TransientValue | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * The breaches of the declared rules, on the instances `scope` concerns: with
 * the instances a transaction touched, the instances it wrote of each schema
 * with rules, and, for a check reading a path through a schema whose instances
 * changed (the schema of an `exists` included), every instance of the schema;
 * with `"all"`, every instance of the dataset. An imported instance is read but
 * never at fault, since it cannot be changed here. Reads only.
 */
export async function evaluateRules(
  impl: PersistenceInterface,
  rest: string,
  resolvers: Resolvers,
  scope: readonly TouchedInstance[] | "all",
): Promise<RuleViolation[]> {
  const schemas = ruledSchemas(resolvers);
  if (schemas.length === 0) return [];
  const namespaces = resolvers.importNamespaces ?? [];
  const ctx: FilterEvalContext = { ...resolvers.ctx, impl, rest };

  // The keys written per stored schema, and the schemas whose instances changed. A facet's
  // instance carries the key of its target, so a change to it is a write of the target.
  const written = new Map<string, Set<Key>>();
  const changed = new Set<string>();
  if (scope !== "all") {
    for (const entry of scope) {
      const stored = resolvers.schemas.get(entry.schema);
      if (!stored) continue;
      const target = isFacet(stored) ? resolvers.schemas.get(String(stored.constraints.facet_of)) : stored;
      if (!target) continue;
      const family = isFacet(stored) ? collectExtendingSchemas(target, resolvers) : [stored];
      for (const s of family) {
        changed.add(s.name);
        if (entry.after !== undefined || isFacet(stored)) {
          if (!written.has(s.name)) written.set(s.name, new Set());
          (written.get(s.name) as Set<Key>).add(entry.key);
        }
      }
    }
  }
  const touches = (dependency: string) => [...changed].some((name) => {
    const s = resolvers.schemas.get(name);
    return s !== undefined && isSchemaOrDescendant(s, dependency, resolvers);
  });

  const violations: RuleViolation[] = [];
  const listCache = new Map<string, TransientObject[]>();
  const listFamily = async (root: NormalizedSchema): Promise<{ schema: NormalizedSchema; instance: TransientObject }[]> => {
    const out: { schema: NormalizedSchema; instance: TransientObject }[] = [];
    for (const s of collectExtendingSchemas(root, resolvers)) {
      let list = listCache.get(s.name);
      if (!list) {
        list = (await impl.listInstances(rest, s.name, derivePropertyRoles(s))) as TransientObject[];
        listCache.set(s.name, list);
      }
      for (const instance of list) out.push({ schema: s, instance });
    }
    return out;
  };

  for (const schema of schemas) {
    const checks = checksOf(schema.constraints);
    const groups = uniqueGroupsOf(schema.constraints);
    const acyclic = schema.properties.filter((p) => p.constraints.acyclic === true);
    const all = scope === "all";
    const everyInstance = all || checks.some((check) => dependencies(schema, check, resolvers).some(touches));
    const writtenHere = written.get(schema.name) ?? new Set<Key>();
    if (!everyInstance && writtenHere.size === 0) continue;

    const roles = derivePropertyRoles(schema);
    const stored = (await impl.listInstances(rest, schema.name, roles)) as TransientObject[];
    for (const raw of stored) {
      const key = keyOf(schema, raw);
      if (importNamespaceOf(key, namespaces) !== undefined) continue;
      const isWritten = all || writtenHere.has(key);
      if (!isWritten && !everyInstance) continue;
      const instance = await resolveVirtualProperties(impl, rest, resolvers, schema, clone(raw) as TransientObject, new Map());
      const breach = (rule: string, message: string) => violations.push({ rule, schema: schema.name, key, message: `"${key}" of "${schema.name}" breaks the rule "${rule}": ${message}` });

      for (const check of checks) {
        if (!isWritten && !dependencies(schema, check, resolvers).some(touches)) continue;
        if (check.when && !(await matchFilter(instance, check.when, schema, ctx))) continue;
        if (check.require) {
          if (!(await matchFilter(instance, check.require, schema, ctx))) breach(check.name, "its require does not hold");
          continue;
        }
        if (check.exists && !(await existsHolds(check, instance, schema, ctx, resolvers, listFamily))) {
          breach(check.name, `no instance of "${check.exists.schema}" has the values it requires`);
        }
      }

      if (!isWritten) continue;
      for (const group of groups) {
        const values = group.properties.map((p) => instance[p]);
        const relation = (p: string) => {
          const prop = findProperty(schema, p);
          return prop !== undefined && resolveType(prop.type, resolvers.ctx).kind === "relation";
        };
        // a group with a null relation does not count
        if (group.properties.some((p, i) => relation(p) && (values[i] === null || values[i] === undefined))) continue;
        const root = uniqueRoot(schema, group.name, resolvers);
        for (const other of await listFamily(root)) {
          if (other.schema.name === schema.name && keyOf(other.schema, other.instance) === key) continue;
          if (group.properties.every((p, i) => sameValue(other.instance[p], values[i]))) {
            breach(group.name, `"${keyOf(other.schema, other.instance)}" has the same ${group.properties.join(", ")}`);
            break;
          }
        }
      }
      for (const prop of acyclic) {
        const target = resolvers.schemas.get(prop.type);
        if (!target) continue;
        const family = await listFamily(target);
        const byKey = new Map(family.map((f) => [keyOf(f.schema, f.instance), f.instance] as const));
        const seen = new Set<Key>();
        let next = instance[prop.name];
        while (typeof next === "string") {
          if (next === key) {
            breach(prop.name, `following "${prop.name}" leads back to it`);
            break;
          }
          if (seen.has(next)) break;
          seen.add(next);
          next = byKey.get(next)?.[prop.name] ?? null;
        }
      }
    }
  }
  return violations;
}

/** The topmost schema of the `extends` chain of `schema` that declares the unique group `name`: the group covers its descendants together. */
function uniqueRoot(schema: NormalizedSchema, name: string, resolvers: Resolvers): NormalizedSchema {
  let current = schema;
  while (current.extends) {
    const parent = resolvers.schemas.get(current.extends);
    if (!parent || !uniqueGroupsOf(parent.constraints).some((g) => g.name === name)) break;
    current = parent;
  }
  return current;
}

async function existsHolds(
  check: CheckRule,
  instance: TransientObject,
  schema: NormalizedSchema,
  ctx: FilterEvalContext,
  resolvers: Resolvers,
  listFamily: (root: NormalizedSchema) => Promise<{ schema: NormalizedSchema; instance: TransientObject }[]>,
): Promise<boolean> {
  const exists = check.exists as NonNullable<CheckRule["exists"]>;
  const target = resolvers.schemas.get(exists.schema);
  if (!target) return false;
  const read = async (value: TransientValue): Promise<TransientValue> => {
    const path = thisPath(value);
    return path ? ((await valueOnPath(instance, schema, path, ctx)) ?? null) : value;
  };
  let each: TransientValue[] = [null];
  if (Array.isArray(check.each)) each = await Promise.all(check.each.map(read));
  else if (check.each !== undefined) {
    const list = await read(check.each);
    each = Array.isArray(list) ? list : [];
  }
  const candidates = await listFamily(target);
  for (const value of each) {
    const wanted: [string, TransientValue][] = [];
    for (const [name, raw] of Object.entries(exists.with)) {
      wanted.push([name, typeof raw === "string" && EACH.test(raw.trim()) ? value : await read(raw)]);
    }
    const found = candidates.some((c) => wanted.every(([name, v]) => sameValue(c.instance[name === "name" || name === "id" ? (keyPropertyName(c.schema) ?? name) : name], v)));
    if (!found) return false;
  }
  return true;
}

/**
 * The `rule_violation` refusing a transaction for `violations`: `details`
 * gives the first breach as `rule`, `schema` and `key`, and every breach in
 * `violations`.
 */
export function ruleViolationError(violations: readonly RuleViolation[], what = "the transaction"): Error {
  const first = violations[0];
  const more = violations.length > 1 ? ` (and ${violations.length - 1} more)` : "";
  return modelError("rule_violation", `${what} is refused: ${first.message}${more}`, {
    rule: first.rule,
    schema: first.schema,
    key: first.key,
    violations: violations.map((v) => ({ rule: v.rule, schema: v.schema, key: v.key })),
  });
}
