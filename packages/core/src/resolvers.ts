import { META_SCHEMAS } from "./builtins.js";
import { loadDatasetModel } from "./datasetModules.js";
import { MCL_CORE } from "./mclCore.js";
import { NO_ROLES, SCHEMA_ROLES } from "./schemaProcessing.js";
import type { TypeResolutionContext } from "./schemaProcessing.js";
import type { NormalizedScalarType, NormalizedSchema, PersistenceInterface } from "./types.js";

/**
 * Loads every schema and scalar_type currently stored in the dataset (plus the
 * built-in meta-schemas) into plain Maps, so schema/type resolution during a
 * single command or script run can be synchronous. Datasets are expected to be
 * small enough (this is a modelling tool, not a data warehouse) that reloading
 * per command is simpler than incremental caching — see the core README.
 * META_SCHEMAS includes `schema`, `scalar_type`, and `dataset`, so
 * they're all resolvable.
 */
export interface Resolvers {
  ctx: TypeResolutionContext;
  schemas: Map<string, NormalizedSchema>;
  scalarTypes: Map<string, NormalizedScalarType>;
  /**
   * The namespaces of the imports of the dataset, each ending with a dot: an
   * instance whose key starts with one is an imported instance, read-only and
   * reached by a `query` that names its namespace (see `docs/datasets.md`,
   * Imports). Absent: none.
   */
  importNamespaces?: string[];
}

/** The `import` schema of `mcl:core`, which a command can query in any dataset. */
const IMPORT_SCHEMA = MCL_CORE.schemas.find((s) => s.name === "import") as NormalizedSchema;

/** The namespace of the import that `key` belongs to, or `undefined` for an instance of the dataset itself. */
export function importNamespaceOf(key: string, namespaces: readonly string[]): string | undefined {
  let found: string | undefined;
  for (const ns of namespaces) if (key.startsWith(ns) && (found === undefined || ns.length > found.length)) found = ns;
  return found;
}

/**
 * A deferred, re-callable way to get a locator's `Resolvers` — what
 * script.ts's `createScriptSession`/`runScript` take instead of a resolved
 * `Resolvers` value, so the caching policy (reload every call, load once for
 * one script session, or share one load across many sessions and calls) is
 * entirely up to whoever provides the lookup — plain `loadResolvers` wrapped
 * fresh each time, a value already loaded once and returned as-is on every
 * call, or an `ApiSession`'s per-locator cache (see api.ts). script.ts itself
 * doesn't know or care which.
 */
export type ResolversLookup = () => Promise<Resolvers>;

export async function loadResolvers(impl: PersistenceInterface, rest: string): Promise<Resolvers> {
  const schemas = new Map<string, NormalizedSchema>(Object.entries(META_SCHEMAS));
  const scalarTypes = new Map<string, NormalizedScalarType>();

  for (const raw of await impl.listInstances(rest, "schema", SCHEMA_ROLES)) {
    const s = raw as unknown as NormalizedSchema;
    // A schema stored before `content` was part of the meta-schema reads back
    // without it; treated as empty so `${this.schema.content}` resolves to an
    // empty string rather than raising unknown_reference.
    schemas.set(s.name, s.content === undefined ? { ...s, content: "" } : s);
  }

  for (const raw of await impl.listInstances(rest, "scalar_type", NO_ROLES)) {
    const st = raw as unknown as NormalizedScalarType;
    scalarTypes.set(st.name, st);
  }

  // The modules of the dataset: their schemas and scalar types by qualified
  // name, and the standard types of mcl:core. A schema or scalar type the
  // dataset stores itself, or reads from its built-in, keeps its name.
  const model = await loadDatasetModel(impl, rest);
  if (model) {
    for (const [key, schema] of model.schemas) if (!schemas.has(key)) schemas.set(key, schema);
    for (const [key, type] of model.scalarTypes) if (!scalarTypes.has(key)) scalarTypes.set(key, type);
  }
  if (!schemas.has(IMPORT_SCHEMA.name)) schemas.set(IMPORT_SCHEMA.name, IMPORT_SCHEMA);

  const importNamespaces = (await impl.listInstances(rest, "import", NO_ROLES))
    .map((raw) => (raw as Record<string, unknown>).namespace)
    .filter((ns): ns is string => typeof ns === "string" && ns !== "");

  const ctx: TypeResolutionContext = {
    resolveSchema: (name) => schemas.get(name),
    resolveScalarType: (name) => scalarTypes.get(name),
  };

  return { ctx, schemas, scalarTypes, importNamespaces };
}
