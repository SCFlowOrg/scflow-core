import {
  matchReference,
  qualifiedName,
  referenceOfIn,
  isUuid,
  type DatasetModel,
  type NamedInstance,
  type NamedInstances,
  type NormalizedProperty,
  type NormalizedSchema,
  type TransientObject,
} from "@scfloworg/core";
import { candidatesOf, keyOf, loadIndex, sheetSchemas, shortName } from "./model.js";
import { SpreadsheetError, type SpreadsheetDataset } from "./types.js";

/** The separator of the parts of the label of an entity that has no name. */
export const LABEL_SEPARATOR = " | ";

/** A label with its parts trimmed and its empty trailing parts dropped, so that two ways of writing one label compare equal. */
export function normalizeLabel(text: string): string {
  const parts = text.split("|").map((p) => p.trim());
  while (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts.join(LABEL_SEPARATOR);
}

/** An instance of a schema without a name: its key, its schema, and the values of the properties of its key. */
export interface Unnamed {
  key: string;
  schema: string;
  values: TransientObject;
}

/**
 * Every entity of the dataset that a relation can point at, with the text that
 * designates it. An entity with a name is designated by its name, as short as it
 * stays unambiguous (`Paris`, `France / Lyon`). An entity without a name is
 * designated by its **label**: the values of the properties of its key, each
 * relation written as the reference of its target, joined by ` | `. A flow is
 * `Plant | Depot | Bolt`, an item held `Plant | Bolt`. When a relation can point
 * at several schemas, as the `annotated` of a note can, the reference starts with
 * the schema: `actor: Plant`.
 */
export class Catalog {
  readonly unnamed = new Map<string, Unnamed>();
  private version = 0;
  private cache = new Map<string, string>();
  private cacheVersion = 0;

  constructor(
    readonly model: DatasetModel,
    readonly languages: readonly string[],
    readonly named: NamedInstances,
  ) {}

  /** Tells the catalog an entity was added, so that the references computed so far are computed again. */
  changed(): void {
    this.version += 1;
  }

  addUnnamed(entity: Unnamed): void {
    this.unnamed.set(entity.key, entity);
    this.changed();
  }

  /** The schema of an entity, named or not. */
  schemaOf(key: string): string | undefined {
    return this.named.get(key)?.schema ?? this.unnamed.get(key)?.schema;
  }

  private text(property: NormalizedProperty, value: unknown, trail: string[]): string {
    if (value === null || value === undefined || value === "") return "";
    if (typeof value === "object" && !Array.isArray(value)) {
      const map = value as Record<string, string>;
      for (const language of this.languages) if (typeof map[language] === "string" && map[language] !== "") return map[language];
      return Object.values(map).find((t) => typeof t === "string" && t !== "") ?? "";
    }
    const target = this.model.schemas.get(property.type);
    if (target && typeof value === "string") return this.referenceIn(value, candidatesOf(this.model, target), trail);
    return String(value);
  }

  /** The label of an entity without a name. */
  labelOf(key: string, trail: string[] = []): string {
    if (this.cacheVersion !== this.version) {
      this.cache.clear();
      this.cacheVersion = this.version;
    }
    const known = this.cache.get(key);
    if (known !== undefined) return known;
    const entity = this.unnamed.get(key);
    if (!entity || trail.includes(key)) return key;
    const schema = this.model.schemas.get(entity.schema) as NormalizedSchema;
    const properties = keyOf(schema).kind === "name" ? [] : (keyOf(schema) as { properties: string[] }).properties;
    const parts = properties.map((name) => {
      const property = schema.properties.find((p) => p.name === name) as NormalizedProperty;
      return this.text(property, entity.values[name], [...trail, key]);
    });
    while (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
    const label = parts.join(LABEL_SEPARATOR);
    this.cache.set(key, label);
    return label;
  }

  /** The reference of any entity, without a schema prefix: its shortest name, or its label. */
  reference(key: string, trail: string[] = []): string {
    if (this.named.has(key)) return referenceOfIn(this.named, key, this.languages).reference;
    return this.labelOf(key, trail);
  }

  /** The text that designates `key` in a cell whose relation can point at `candidates`: prefixed with the schema when there are several. */
  referenceIn(key: string, candidates: readonly NormalizedSchema[], trail: string[] = []): string {
    const text = this.reference(key, trail);
    if (candidates.length < 2) return text;
    const schema = this.schemaOf(key) as string;
    const short = candidates.filter((c) => shortName(c.name) === shortName(schema)).length > 1 ? schema : shortName(schema);
    return `${short}: ${text}`;
  }

  /** The full name of an entity, to say which one: the qualified name, or the label. */
  describe(key: string): string {
    const named = this.named.get(key);
    return named ? qualifiedName(named, this.named, this.languages) : this.labelOf(key);
  }

  /**
   * The entity a reference designates, among the instances of `candidates`: an id; or a
   * name as short as it stays unambiguous; or a label. A prefix `schema:` keeps one schema.
   * Throws a `SpreadsheetError` of code `unresolved_reference` or `ambiguous_reference`; the
   * second lists the candidates.
   */
  resolve(text: string, candidates: readonly NormalizedSchema[]): { key: string; schema: string } {
    let pool = candidates;
    let wanted = text.trim();
    if (candidates.length > 1) {
      const prefix = /^([^:]+):\s*([\s\S]*)$/.exec(wanted);
      const chosen = prefix ? candidates.filter((c) => c.name === prefix[1].trim() || shortName(c.name) === prefix[1].trim()) : [];
      if (prefix && chosen.length === 1) {
        pool = chosen;
        wanted = prefix[2].trim();
      }
    }
    const names = new Set(pool.map((c) => c.name));
    if (isUuid(wanted)) {
      const schema = this.schemaOf(wanted);
      if (schema !== undefined && names.has(schema)) return { key: wanted, schema };
    }
    const found: { key: string; schema: string; text: string }[] = [];
    for (const i of matchReference(this.named, wanted, (n: NamedInstance) => names.has(n.schema))) {
      found.push({ key: i.key, schema: i.schema, text: qualifiedName(i, this.named, this.languages) });
    }
    const normalized = normalizeLabel(wanted);
    for (const entity of this.unnamed.values()) {
      if (names.has(entity.schema) && normalizeLabel(this.labelOf(entity.key)) === normalized) found.push({ key: entity.key, schema: entity.schema, text: this.labelOf(entity.key) });
    }
    const what = pool.length === 1 ? ` of "${pool[0].name}"` : "";
    if (found.length === 0) throw new SpreadsheetError("unresolved_reference", `"${text}" designates no instance${what}`);
    if (found.length > 1) {
      const list = found.map((f) => (pool.length > 1 ? `${shortName(f.schema)}: ${f.text}` : f.text)).sort();
      throw new SpreadsheetError("ambiguous_reference", `"${text}" designates ${found.length} instances${what}: ${list.map((c) => `"${c}"`).join(", ")}; give more of the qualified name`);
    }
    return { key: found[0].key, schema: found[0].schema };
  }
}

/**
 * The catalog of a dataset: its named entities, read through `query`, and its entities without a name, with the
 * stored instances of every schema that has a sheet, by schema.
 */
export async function loadCatalog(dataset: SpreadsheetDataset, model: DatasetModel, languages: readonly string[]): Promise<{ catalog: Catalog; stored: Map<string, TransientObject[]> }> {
  const catalog = new Catalog(model, languages, await loadIndex(dataset, model));
  const stored = new Map<string, TransientObject[]>();
  for (const schema of sheetSchemas(model)) {
    const instances = (await dataset.query({ query: schema.name } as never)).after as TransientObject[];
    stored.set(schema.name, instances);
    const key = keyOf(schema);
    if (key.kind === "name") continue;
    for (const instance of instances) {
      catalog.unnamed.set(instance.id as string, { key: instance.id as string, schema: schema.name, values: Object.fromEntries(key.properties.map((p) => [p, instance[p]])) });
    }
  }
  catalog.changed();
  return { catalog, stored };
}
