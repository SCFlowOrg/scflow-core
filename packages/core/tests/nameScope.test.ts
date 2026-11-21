import { describe, expect, it } from "vitest";
import { ModelError } from "../src/errors.js";
import { loadNamedInstances, nameBreaches, qualifiedName, referenceOfIn, resolveReference } from "../src/names.js";
import { loadResolvers } from "../src/resolvers.js";
import { processSchemaDescription } from "../src/schemaProcessing.js";
import { createUpgradeLocator, registerPersistentFormat, runCommand, upgradeDataset } from "../src/testing.js";
import type { NormalizedSchema, PersistenceInterface, TransientObject } from "../src/types.js";
import { fakeFormat, noScalarTypes } from "./mapTestSupport.js";

/**
 * The schema constraint `name_scope`, meta-model.md#names-and-references:
 * its declaration, the uniqueness of names in a scope, the qualified name, the
 * resolution of a reference and the ban of `shared_by_name` outside the
 * meta-model. Declaration tests call schema processing directly; the others
 * run through a dataset on a small in-memory format, with `country`, `city`
 * and `line` (three levels), and `site`, a schema whose scope is the dataset.
 */

async function code(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (err) {
    expect(err).toBeInstanceOf(ModelError);
    return (err as ModelError).code;
  }
}

function expectConstraintViolation(fn: () => unknown): void {
  try {
    fn();
    expect.fail("expected a constraint_violation");
  } catch (err) {
    expect(err).toBeInstanceOf(ModelError);
    expect((err as ModelError).code).toBe("constraint_violation");
  }
}

const NAME = { name: "name", type: "string" };

const SCHEMAS: TransientObject[] = [
  { name: "country", name_scope: [], properties: [{ name: "name", type: "localized_string" }] },
  { name: "city", name_scope: ["country"], properties: [NAME, { name: "country", type: "country", mandatory: true }] },
  { name: "line", name_scope: ["city"], properties: [NAME, { name: "city", type: "city", mandatory: true }] },
  // a descendant through extends: it shares the family, hence the names, of line
  { name: "special_line", extends: "line", properties: [] },
  { name: "site", name_scope: [], properties: [NAME] },
];

async function dataset(schemas: TransientObject[] = SCHEMAS): Promise<{ impl: PersistenceInterface; locator: string; rest: string }> {
  const impl = fakeFormat();
  registerPersistentFormat(impl);
  await impl.createDataset("d1", "Test");
  const locator = `${impl.name}:d1`;
  const upgrade = await createUpgradeLocator(locator);
  await runCommand(upgrade, { kind: "create", schema: "schema", input: schemas });
  await upgradeDataset(locator, upgrade);
  return { impl, locator, rest: "d1" };
}

const create = async (locator: string, schema: string, ...input: TransientObject[]) => (await runCommand(locator, { kind: "create", schema, input })).after as TransientObject[];
const idOf = (instance: TransientObject) => instance.id as string;

/** France with two cities, Lyon and Paris, each with a `Line 1`; the ids by qualified name. */
async function network() {
  const ctx = await dataset();
  const [france] = await create(ctx.locator, "country", { name: { en: "France", fr: "France" } });
  const [lyon, paris] = await create(ctx.locator, "city", { name: "Lyon", country: idOf(france) }, { name: "Paris", country: idOf(france) });
  const [lyon1, paris1, assembly] = await create(ctx.locator, "line", { name: "Line 1", city: idOf(lyon) }, { name: "Line 1", city: idOf(paris) }, { name: "Assembly", city: idOf(paris) });
  const resolvers = await loadResolvers(ctx.impl, ctx.rest);
  return { ...ctx, resolvers, ids: { france: idOf(france), lyon: idOf(lyon), paris: idOf(paris), lyon1: idOf(lyon1), paris1: idOf(paris1), assembly: idOf(assembly) } };
}

describe("name_scope — declaration", () => {
  it("is kept by schema processing, with the empty list for the dataset", () => {
    const schema = processSchemaDescription({ name: "site", name_scope: [], properties: [NAME] }, noScalarTypes);
    expect(schema.constraints.name_scope).toEqual([]);
  });

  it("refuses a value that is not a list of names", () => {
    expectConstraintViolation(() => processSchemaDescription({ name: "site", name_scope: null, properties: [NAME] }, noScalarTypes));
    expectConstraintViolation(() => processSchemaDescription({ name: "site", name_scope: "parent", properties: [NAME] }, noScalarTypes));
    expectConstraintViolation(() => processSchemaDescription({ name: "site", name_scope: ["a", "a"], properties: [NAME] }, noScalarTypes));
  });

  it("refuses a schema without a property name of type string or localized_string", () => {
    expectConstraintViolation(() => processSchemaDescription({ name: "site", name_scope: [], properties: [] }, noScalarTypes));
    expectConstraintViolation(() => processSchemaDescription({ name: "site", name_scope: [], properties: [{ name: "name", type: "identifier" }] }, noScalarTypes));
    expect(processSchemaDescription({ name: "site", name_scope: [], properties: [{ name: "name", type: "localized_string" }] }, noScalarTypes).name).toBe("site");
  });

  it("is incompatible with shared_by_name, embedded and facet_of", () => {
    for (const other of [{ shared_by_name: true }, { embedded: true }, { facet_of: "site" }]) {
      expectConstraintViolation(() => processSchemaDescription({ name: "x", name_scope: [], properties: [NAME], ...other }, noScalarTypes));
    }
  });

  it("is inherited through extends, which cannot change the list", () => {
    const base: NormalizedSchema = processSchemaDescription({ name: "base", name_scope: [], properties: [NAME, { name: "owner", type: "string" }] }, noScalarTypes);
    const ctx = { resolveSchema: (n: string) => (n === "base" ? base : undefined), resolveScalarType: () => undefined };
    const child = processSchemaDescription({ name: "child", extends: "base", properties: [] }, ctx);
    expect(child.constraints.name_scope).toEqual([]);
    expect(processSchemaDescription({ name: "same", extends: "base", name_scope: [], properties: [] }, ctx).constraints.name_scope).toEqual([]);
    expectConstraintViolation(() => processSchemaDescription({ name: "other", extends: "base", name_scope: ["owner"], properties: [] }, ctx));
  });

  it("names single-valued relations of schemas that have a name_scope themselves", async () => {
    const owned = { name: "owned", name_scope: ["site"], properties: [NAME, { name: "site", type: "site" }] };
    const site = SCHEMAS[4];
    await dataset([site, owned]);
    // a property that does not exist, a scalar, an array and a relation to a schema without name_scope
    const bad = (extra: TransientObject, constraint: string[]) => dataset([site, { name: "plain", properties: [] }, { name: "owned", name_scope: constraint, properties: [NAME, extra] }]);
    expect(await code(bad({ name: "other", type: "string" }, ["missing"]))).toBe("constraint_violation");
    expect(await code(bad({ name: "other", type: "string" }, ["other"]))).toBe("constraint_violation");
    expect(await code(bad({ name: "other", type: "site", is_array: true }, ["other"]))).toBe("constraint_violation");
    expect(await code(bad({ name: "other", type: "plain" }, ["other"]))).toBe("constraint_violation");
  });
});

describe("shared_by_name is reserved to the meta-model", () => {
  it("is refused on a schema a dataset creates, on create and on update", async () => {
    expect(await code(dataset([{ name: "tip", shared_by_name: true, properties: [{ name: "name", type: "identifier" }] }]))).toBe("constraint_violation");
    const { locator } = await dataset([{ name: "tip", properties: [NAME] }]);
    const upgrade = await createUpgradeLocator(locator);
    expect(await code(runCommand(upgrade, { kind: "update", schema: "schema", filters: { name: "tip" }, input: [{ shared_by_name: true, properties: [{ name: "name", type: "identifier" }] }] }))).toBe("constraint_violation");
  });
});

describe("name_scope — names", () => {
  it("makes the name mandatory, not empty, and free of the separator", async () => {
    const { locator } = await dataset();
    expect(await code(create(locator, "site", {}))).toBe("constraint_violation");
    expect(await code(create(locator, "site", { name: "  " }))).toBe("constraint_violation");
    expect(await code(create(locator, "site", { name: "Lyon / Line 1" }))).toBe("constraint_violation");
    expect(await code(create(locator, "country", { name: { en: "France", fr: "Fr/ance" } }))).toBe("constraint_violation");
    expect(await code(create(locator, "country", { name: {} }))).toBe("constraint_violation");
    const [site] = await create(locator, "site", { name: "Lyon" });
    expect(await code(runCommand(locator, { kind: "update", schema: "site", filters: { id: idOf(site) }, input: [{ name: "a/b" }] }))).toBe("constraint_violation");
  });

  it("refuses two instances with the same name in one scope, the schema and the descendants alike", async () => {
    const { locator, ids } = await network();
    const error = await create(locator, "line", { name: "Line 1", city: ids.lyon }).catch((e) => e as ModelError);
    expect(error).toBeInstanceOf(ModelError);
    expect((error as ModelError).code).toBe("rule_violation");
    expect((error as ModelError).details).toMatchObject({ rule: "name_scope", schema: "line" });
    expect((error as ModelError).message).toContain("Lyon");
    // a descendant through extends shares the family, hence the scope
    expect(await code(create(locator, "special_line", { name: "Assembly", city: ids.paris }))).toBe("rule_violation");
    // the same name in another scope, and in a scope that is another schema, is fine
    expect(await code(create(locator, "special_line", { name: "Assembly", city: ids.lyon }))).toBeUndefined();
    expect(await code(create(locator, "site", { name: "Line 1" }))).toBeUndefined();
  });

  it("refuses a rename or a move that creates a duplicate", async () => {
    const { locator, ids } = await network();
    expect(await code(runCommand(locator, { kind: "update", schema: "line", filters: { id: ids.paris1 }, input: [{ name: "Assembly" }] }))).toBe("rule_violation");
    expect(await code(runCommand(locator, { kind: "update", schema: "line", filters: { id: ids.paris1 }, input: [{ city: ids.lyon }] }))).toBe("rule_violation");
  });

  it("compares every language, exactly after trimming, case-sensitively", async () => {
    const { locator } = await dataset();
    await create(locator, "country", { name: { en: "Germany", fr: "Allemagne" } });
    expect(await code(create(locator, "country", { name: { fr: " Allemagne " } }))).toBe("rule_violation");
    expect(await code(create(locator, "country", { name: { en: "Allemagne" } }))).toBe("rule_violation");
    expect(await code(create(locator, "country", { name: { en: "allemagne" } }))).toBeUndefined();
  });
});

describe("name_scope — qualified names and resolution", () => {
  it("qualifies a name by its three levels of scope", async () => {
    const { impl, rest, resolvers, ids } = await network();
    const all = await loadNamedInstances(impl, rest, resolvers);
    expect(qualifiedName(all.get(ids.lyon1)!, all)).toBe("France / Lyon / Line 1");
    expect(qualifiedName(all.get(ids.france)!, all, ["fr"])).toBe("France");
    expect(nameBreaches(all, "all")).toEqual([]);
  });

  it("resolves an id first, then a contiguous suffix of the qualified name, in any spacing", async () => {
    const { impl, rest, resolvers, ids } = await network();
    const resolve = (text: string, schema?: string) => resolveReference(impl, rest, resolvers, text, { schema }).then((r) => r.key);
    expect(await resolve(ids.paris1)).toBe(ids.paris1);
    expect(await resolve("Assembly")).toBe(ids.assembly);
    expect(await resolve("Paris / Assembly")).toBe(ids.assembly);
    expect(await resolve("Paris/Assembly")).toBe(ids.assembly);
    expect(await resolve(" France / Paris / Assembly ")).toBe(ids.assembly);
    expect(await resolve("Lyon / Line 1")).toBe(ids.lyon1);
    expect(await resolve("Lyon")).toBe(ids.lyon);
    // a segment must be contiguous: France / Line 1 skips a level
    expect(await code(resolve("France / Line 1"))).toBe("unresolved_reference");
    expect(await code(resolve("Nowhere"))).toBe("unresolved_reference");
    expect(await code(resolve("lyon"))).toBe("unresolved_reference");
    // an unknown uuid is read as a name, and so resolves nothing
    expect(await code(resolve("00000000-0000-4000-8000-000000000000"))).toBe("unresolved_reference");
  });

  it("refuses an ambiguous reference with the full qualified names of the candidates", async () => {
    const { impl, rest, resolvers } = await network();
    const error = (await resolveReference(impl, rest, resolvers, "Line 1").catch((e) => e)) as ModelError;
    expect(error.code).toBe("ambiguous_reference");
    expect(error.details?.candidates).toEqual(["France / Lyon / Line 1", "France / Paris / Line 1"]);
    expect(error.message).toContain("France / Paris / Line 1");
  });

  it("reads each segment in every language of its name", async () => {
    const { impl, rest, resolvers, ids } = await network();
    const [fr, en] = ["France", "France"];
    expect((await resolveReference(impl, rest, resolvers, `${fr} / Lyon / Line 1`)).key).toBe(ids.lyon1);
    expect(en).toBe("France");
    const { locator, impl: i2, rest: r2 } = await dataset();
    const [de] = await create(locator, "country", { name: { en: "Germany", fr: "Allemagne" } });
    const resolvers2 = await loadResolvers(i2, r2);
    expect((await resolveReference(i2, r2, resolvers2, "Allemagne")).key).toBe(idOf(de));
    expect((await resolveReference(i2, r2, resolvers2, "Germany")).key).toBe(idOf(de));
  });

  it("keeps only the candidates of the schema a reference is for, scopes of the whole dataset", async () => {
    const { locator, impl, rest, ids } = await network();
    await create(locator, "site", { name: "Assembly" });
    const resolvers = await loadResolvers(impl, rest);
    expect(await code(resolveReference(impl, rest, resolvers, "Assembly"))).toBe("ambiguous_reference");
    expect((await resolveReference(impl, rest, resolvers, "Assembly", { schema: "line" })).key).toBe(ids.assembly);
    expect((await resolveReference(impl, rest, resolvers, "Paris / Assembly", { schema: "special_line" }).catch((e) => e)).code).toBe("unresolved_reference");
  });

  it("follows a moved scope: the relations hold ids, the qualified name changes", async () => {
    const { locator, impl, rest, ids } = await network();
    const [spain] = await create(locator, "country", { name: { en: "Spain" } });
    await runCommand(locator, { kind: "update", schema: "city", filters: { id: ids.lyon }, input: [{ country: idOf(spain) }] });
    const resolvers = await loadResolvers(impl, rest);
    const all = await loadNamedInstances(impl, rest, resolvers);
    expect(qualifiedName(all.get(ids.lyon1)!, all)).toBe("Spain / Lyon / Line 1");
    expect((await resolveReference(impl, rest, resolvers, "Spain / Lyon / Line 1")).key).toBe(ids.lyon1);
    expect(await code(resolveReference(impl, rest, resolvers, "France / Lyon / Line 1"))).toBe("unresolved_reference");
  });
});

describe("name_scope — export of a reference", () => {
  it("gives the shortest suffix that is unambiguous now, and the full path", async () => {
    const { impl, rest, resolvers, ids, locator } = await network();
    const all = await loadNamedInstances(impl, rest, resolvers);
    expect(referenceOfIn(all, ids.assembly)).toEqual({ reference: "Assembly", full: "France / Paris / Assembly" });
    expect(referenceOfIn(all, ids.lyon1)).toEqual({ reference: "Lyon / Line 1", full: "France / Lyon / Line 1" });
    expect(referenceOfIn(all, ids.france)).toEqual({ reference: "France", full: "France" });

    // two cities called Lyon in two countries: the reference of a line goes up to the country
    const [spain] = await create(locator, "country", { name: { en: "Spain" } });
    const [lyonEs] = await create(locator, "city", { name: "Lyon", country: idOf(spain) });
    const [lineEs] = await create(locator, "line", { name: "Line 1", city: idOf(lyonEs) });
    const after = await loadNamedInstances(impl, rest, await loadResolvers(impl, rest));
    expect(referenceOfIn(after, ids.lyon1).reference).toBe("France / Lyon / Line 1");
    expect(referenceOfIn(after, idOf(lineEs)).reference).toBe("Spain / Lyon / Line 1");
    expect(referenceOfIn(after, idOf(lyonEs)).reference).toBe("Spain / Lyon");
    // the name of a country in the source language, with a fallback to any language
    expect(referenceOfIn(after, ids.france, ["de", "fr"]).reference).toBe("France");
  });
});

describe("name_scope — two plants each with a Line 1", () => {
  it("is the same instance name in two scopes, qualified by the plant", async () => {
    const { locator, impl, rest } = await dataset([
      { name: "plant", name_scope: [], properties: [NAME] },
      { name: "line", name_scope: ["plant"], properties: [NAME, { name: "plant", type: "plant", mandatory: true }] },
    ]);
    const [a, b] = await create(locator, "plant", { name: "Lyon" }, { name: "Paris" });
    await create(locator, "line", { name: "Line 1", plant: idOf(a) }, { name: "Line 1", plant: idOf(b) });
    const resolvers = await loadResolvers(impl, rest);
    expect(await code(resolveReference(impl, rest, resolvers, "Line 1"))).toBe("ambiguous_reference");
    expect(await resolveReference(impl, rest, resolvers, "Paris / Line 1")).toMatchObject({ schema: "line" });
  });
});
