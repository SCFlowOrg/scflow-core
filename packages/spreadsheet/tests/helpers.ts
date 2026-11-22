import { load } from "js-yaml";
import type { AuthoredCommand } from "@scfloworg/core";
import { createEnvironment, type OpenDataset } from "@scfloworg/environment";
import { createJsPersistenceInterface } from "@scfloworg/format-js";
import { defineModule } from "@scfloworg/module";

/**
 * A small model of its own, to show that the package reads any schema: a
 * country (localized name, in the dataset), cities in a country, lines in a
 * city, a facet on a line, and two schemas that only refer to themselves.
 */
const plantsYaml = `
name: acme:plants
namespace: plants
version: 1.0.0
mcl: ^1.0
title: Plants
schemas:
  - name: country
    is_root: true
    name_scope: []
    properties:
      - name: name
        type: localized_string
        min_length: 1
      - name: code
        type: string
  - name: city
    is_root: true
    name_scope: [country]
    properties:
      - name: name
        type: string
      - name: country
        type: country
        mandatory: true
      - name: population
        type: integer
      - name: labels
        type: string
        is_array: true
  - name: line
    is_root: true
    name_scope: [city]
    checks:
      - name: capacity_not_negative
        when: { capacity: { exists: true } }
        require: { capacity: { gte: 0 } }
    properties:
      - name: name
        type: string
      - name: city
        type: city
        mandatory: true
      - name: capacity
        type: number
      - name: active
        type: boolean
      - name: remark
        type: localized_markdown
  - name: pair
    is_root: true
    name_scope: []
    properties:
      - name: name
        type: string
      - name: partner
        type: pair
        mandatory: true
  - name: node
    is_root: true
    name_scope: []
    properties:
      - name: name
        type: string
      - name: next
        type: node
  - name: fixed
    is_root: true
    name_scope: []
    crud: { create: none, update: none, delete: none }
    properties:
      - name: name
        type: string
  - name: entity
    abstract: true
    is_root: true
    properties:
      - name: tags
        type: string
        is_array: true
  - name: box
    extends: entity
    is_root: true
    name_scope: []
    properties:
      - name: name
        type: string
  - name: link
    extends: entity
    is_root: true
    unique:
      - name: link_unique
        properties: [source, target]
    properties:
      - name: source
        type: box
        mandatory: true
      - name: target
        type: box
        mandatory: true
      - name: weight
        type: number
  - name: comment
    is_root: true
    properties:
      - name: about
        type: entity
        mandatory: true
      - name: text
        type: localized_markdown
  - name: memo
    is_root: true
    properties:
      - name: text
        type: string
`;

const carbonYaml = `
name: acme:carbon
namespace: carbon
version: 1.0.0
mcl: ^1.0
title: Carbon
dependencies:
  - module: acme:plants
    version: ^1.0
schemas:
  - name: line_footprint
    facet_of: plants.line
    properties:
      - name: co2
        type: number
      - name: label
        type: localized_string
`;

const manifest = (yaml: string) => load(yaml) as Record<string, unknown>;

let counter = 0;

/** An environment with the two modules and a new dataset, in French then English. */
export async function setup(options: { languages?: string[]; facet?: boolean } = {}) {
  const env = createEnvironment({ formats: [createJsPersistenceInterface()] });
  env.modules.install(defineModule(manifest(plantsYaml), {}));
  env.modules.install(defineModule(manifest(carbonYaml), {}));
  const open = async (locator: string): Promise<OpenDataset> =>
    env.datasets.create({
      locator,
      modules: options.facet === false ? ["acme:plants"] : ["acme:plants", "acme:carbon"],
      languages: options.languages ?? ["fr", "en"],
    });
  counter += 1;
  const dataset = await open(`js:plants${counter}`);
  counter += 1;
  const fresh = () => open(`js:plants${++counter}`);
  return { env, dataset, fresh };
}

/** Boxes and links: entities with no name, found by their key. */
export async function seedLinks(dataset: OpenDataset): Promise<void> {
  await dataset.run("plants/create_box", { name: "A" });
  await dataset.run("plants/create_box", { name: "B" });
  await dataset.run("plants/create_box", { name: "C" });
  await dataset.run("plants/create_link", { source: "A", target: "B", weight: 1 });
  await dataset.run("plants/create_link", { source: "B", target: "C", weight: 2 });
}

/** The instances of a schema, as the dataset holds them. */
export async function all(dataset: OpenDataset, schema: string): Promise<Record<string, any>[]> {
  return (await dataset.query({ query: `plants.${schema}` } as AuthoredCommand)).after as Record<string, any>[];
}

/** Creates the instances of a small dataset through the actions: France (Paris, Lyon), Spain (Lyon is not there), with lines. */
export async function seed(dataset: OpenDataset): Promise<void> {
  await dataset.run("plants/create_country", { name: { fr: "France", en: "France" }, code: "FR" });
  await dataset.run("plants/create_country", { name: { fr: "Allemagne", en: "Germany" } });
  await dataset.run("plants/create_city", { name: "Paris", country: "France", population: 2100000, labels: ["capital", "north"] });
  await dataset.run("plants/create_city", { name: "Lyon", country: "France" });
  await dataset.run("plants/create_city", { name: "Lyon", country: "Germany" });
  await dataset.run("plants/create_line", { name: "Line 1", city: "France / Paris", capacity: 12.5, active: true, remark: { fr: "Rapide", en: "Fast" } });
  await dataset.run("plants/create_line", { name: "Line 1", city: "France / Lyon", capacity: 3 });
}
