import { META_SCHEMAS } from "./builtins.js";
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

  // The area's built-in, loaded live and never cached/copied (see the `import`
  // part of dataset `core`, section
  // "Built-in — virtual, not imported"). Loaded FIRST so `rest`'s own
  // schemas/scalar_types below always win on a name collision. api.ts's
  // `loadBuiltinOverlay` is the same lookup for dump/restore/queryDataset —
  // duplicated here (rather than imported) to keep command.ts's engine free
  // of any dependency on api.ts; keep the two in sync if this changes.
  const builtinRest = impl.builtinRestFor(rest);
  if (await impl.datasetExists(builtinRest)) {
    for (const raw of await impl.listInstances(builtinRest, "schema", SCHEMA_ROLES)) {
      const s = raw as unknown as NormalizedSchema;
      schemas.set(s.name, s.content === undefined ? { ...s, content: "" } : s);
    }
    for (const raw of await impl.listInstances(builtinRest, "scalar_type", NO_ROLES)) {
      const st = raw as unknown as NormalizedScalarType;
      scalarTypes.set(st.name, st);
    }
  }

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

  const ctx: TypeResolutionContext = {
    resolveSchema: (name) => schemas.get(name),
    resolveScalarType: (name) => scalarTypes.get(name),
  };

  return { ctx, schemas, scalarTypes };
}
