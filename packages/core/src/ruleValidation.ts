import { modelError } from "./errors.js";
import { isFacet } from "./facets.js";
import { checkPath, checkRuleFilter } from "./filter.js";
import { checksOf, uniqueGroupsOf } from "./ruleDeclarations.js";
import { findProperty } from "./schema.js";
import { resolveType } from "./schemaProcessing.js";
import type { TypeResolutionContext } from "./schemaProcessing.js";
import type { NormalizedSchema, TransientValue } from "./types.js";

/**
 * The declarations of the rules checked against the whole model (see
 * `rules.ts` for their evaluation, `ruleDeclarations.ts` for what one schema
 * decides alone).
 */

const THIS_ROOT = /^\$\{\s*this((?:\.[A-Za-z_][A-Za-z0-9_]*)+)\s*\}$/;

/** `${each}`, the value an `each` gives in turn to the `with` of an `exists`. */
export const EACH = /^\$\{\s*each\s*\}$/;

/** Whether a schema declares a rule: `checks`, `unique` or an `acyclic` relation. */
export function hasRules(schema: NormalizedSchema): boolean {
  return checksOf(schema.constraints).length > 0 || uniqueGroupsOf(schema.constraints).length > 0 || schema.properties.some((p) => p.constraints.acyclic === true);
}

/** The path a `${this...}` value names, or `undefined` for anything else. */
export function thisPath(value: TransientValue): string[] | undefined {
  if (typeof value !== "string") return undefined;
  const match = THIS_ROOT.exec(value.trim());
  return match ? match[1].slice(1).split(".") : undefined;
}

/**
 * Checks the declarations of every rule against the whole model, once every
 * schema is processed: the paths of `when` and `require`, on the left and on
 * the right, and those of `each` and `with`, resolve and cross single-valued
 * relations only; the schema of an `exists` resolves (`unknown_schema`) and
 * `with` names its properties; a `unique` group names no generated relation;
 * an `acyclic` relation targets its own schema or an ancestor. Every other
 * breach is a `constraint_violation`.
 */
export function validateRules(schemas: ReadonlyMap<string, NormalizedSchema>, ctx: TypeResolutionContext): void {
  for (const schema of schemas.values()) {
    if (!hasRules(schema) || isFacet(schema)) continue;
    const fail = (message: string): never => {
      throw modelError("constraint_violation", `schema "${schema.name}": ${message}`);
    };
    for (const check of checksOf(schema.constraints)) {
      checkRuleFilter(check.when, schema, ctx, `the "when" of "${check.name}"`);
      checkRuleFilter(check.require, schema, ctx, `the "require" of "${check.name}"`);
      if (!check.exists) continue;
      const target = ctx.resolveSchema(check.exists.schema);
      if (!target) throw modelError("unknown_schema", `the check "${check.name}" of "${schema.name}" names "${check.exists.schema}", which is no schema of the model`);
      const values: TransientValue[] = Object.values(check.exists.with);
      if (Array.isArray(check.each)) values.push(...check.each);
      else if (check.each !== undefined) {
        if (!thisPath(check.each)) fail(`the "each" of "${check.name}" is a list, or one placeholder naming a path on this`);
        values.push(check.each);
      }
      for (const name of Object.keys(check.exists.with)) {
        if (!findProperty(target, name) && name !== "id" && name !== "name") fail(`the "with" of "${check.name}" names "${name}", which "${target.name}" does not declare`);
      }
      for (const value of values) {
        const path = thisPath(value);
        if (path) checkPath(schema, path, ctx, true);
        else if (typeof value === "string" && EACH.test(value.trim())) {
          if (check.each === undefined) fail(`the check "${check.name}" reads \${each} but has no "each"`);
        } else if (typeof value === "string" && value.includes("${")) {
          fail(`the check "${check.name}" holds ${JSON.stringify(value)}: a value is a literal, \${each}, or one placeholder naming a path on this`);
        }
      }
    }
    for (const group of uniqueGroupsOf(schema.constraints)) {
      for (const name of group.properties) {
        const prop = findProperty(schema, name);
        if (!prop || prop.constraints.__generated === true) return fail(`the unique group "${group.name}" names "${name}", which is not a direct property of the schema`);
        if (resolveType(prop.type, ctx).kind === "map") fail(`the unique group "${group.name}" names "${name}", a map`);
      }
    }
    for (const prop of schema.properties) {
      if (prop.constraints.acyclic !== true) continue;
      const resolved = resolveType(prop.type, ctx);
      if (resolved.kind !== "relation") fail(`"${prop.name}" is acyclic, which only a relation can be`);
      let ancestor: string | null = schema.name;
      let reached = false;
      while (ancestor) {
        if (ancestor === prop.type) reached = true;
        ancestor = ctx.resolveSchema(ancestor)?.extends ?? null;
      }
      if (!reached) fail(`"${prop.name}" is acyclic, but targets "${prop.type}", which is neither the schema nor one of its ancestors`);
    }
  }
}

