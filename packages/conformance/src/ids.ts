import { createApiSession as createRawApiSession, runCommand as runRawCommand, runScript as runRawScript } from "@scfloworg/core/testing";
const isMapping = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * A deterministic uuid for a name, so that a conformance case can give an
 * instance a known `id` and name it again in a relation. Only schemas of the
 * meta-model are keyed by their name; every other instance is keyed by a uuid.
 */
export function uid(name: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < name.length; i++) {
    a = Math.imul(a ^ name.charCodeAt(i), 0x01000193) >>> 0;
    b = Math.imul(b + name.charCodeAt(i), 0x85ebca6b) >>> 0;
  }
  const hex = (n: number, width: number) => n.toString(16).padStart(width, "0").slice(-width);
  return `00000000-0000-4000-8000-${hex(a, 8)}${hex(b, 4)}`;
}

/**
 * `input`, one entry or a list, with an `id` given to each entry of a schema in
 * `keyed` from its `name`, and each value of a property in `relations` read as
 * the name of the instance it designates, turned into its id.
 */
const META_SCHEMAS = new Set(["", "schema", "scalar_type", "dataset", "import"]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/**
 * A name turned into its id; an id or a placeholder stays as it is. The key of
 * an imported instance is its id prefixed by the namespace of the import, so
 * `catalog.ada` is the prefix, then the id of `ada`.
 */
const turn = (v: unknown): unknown => {
  if (typeof v !== "string" || v.includes("${") || UUID.test(v)) return v;
  const dot = v.lastIndexOf(".");
  return dot < 0 ? uid(v) : v.slice(0, dot + 1) + (UUID.test(v.slice(dot + 1)) ? v.slice(dot + 1) : uid(v.slice(dot + 1)));
};

/** The relations of `entry`, names turned into ids, a mapping holding the values of a facet read with the qualified name `facet.property`. */
function turnRelations(entry: Record<string, unknown>, relations: ReadonlySet<string>, prefix: string): Record<string, unknown> {
  const out = { ...entry };
  for (const [key, value] of Object.entries(out)) {
    const qualified = `${prefix}${key}`;
    if (relations.has(qualified)) {
      if (typeof value === "string") out[key] = turn(value);
      else if (Array.isArray(value)) out[key] = value.map(turn);
    } else if (isMapping(value) && prefix === "") out[key] = turnRelations(value, relations, `${key}.`);
  }
  return out;
}

export function withIds(schema: string, input: unknown, keyed: ReadonlySet<string>, relations: ReadonlySet<string>): unknown {
  const entry = (raw: unknown): unknown => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return raw;
    const out: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
    if ((keyed.has(schema) || (keyed.has("*") && !META_SCHEMAS.has(schema))) && typeof out.name === "string" && out.id === undefined) out.id = uid(out.name);
    return turnRelations(out, relations, "");
  };
  return Array.isArray(input) ? input.map(entry) : entry(input);
}


/** `filters` with each value on a property of `relations` read as a name and turned into an id; a placeholder is left alone. */
function withIdsInFilters(filters: unknown, relations: ReadonlySet<string>): unknown {
  if (Array.isArray(filters)) return filters.map((f) => withIdsInFilters(f, relations));
  if (!isMapping(filters)) return filters;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(filters)) {
    if (key === "and" || key === "or" || key === "not") out[key] = withIdsInFilters(value, relations);
    else if (relations.has(key)) {
            out[key] = typeof value === "string" ? turn(value) : Array.isArray(value) ? value.map(turn) : isMapping(value) ? Object.fromEntries(Object.entries(value).map(([op, v]) => [op, Array.isArray(v) ? v.map(turn) : turn(v)])) : value;
    } else out[key] = value;
  }
  return out;
}

/**
 * A command of a conformance case written with names, as its schemas used to
 * be keyed, turned into one with ids: the entries of the `create`d schemas in
 * `keyed` get `uid(name)` as `id`, and a value on a property of `relations`,
 * in an entry or in a filter, is read as a name.
 */
export function withIdsInCommand(command: unknown, keyed: ReadonlySet<string>, relations: ReadonlySet<string>): unknown {
  if (!isMapping(command)) return command;
  const out: Record<string, unknown> = { ...command };
  const schema = [command.create, command.update, command.delete, command.query, command.schema].find((s) => typeof s === "string") as string | undefined;
  if (schema !== undefined && command.input !== undefined) {
    out.input = command.create !== undefined || command.kind === "create" ? withIds(schema, command.input, keyed, relations) : withIds("", command.input, new Set(), relations);
  }
  if (command.filters !== undefined) out.filters = withIdsInFilters(command.filters, relations);
  if (Array.isArray(command.commands)) out.commands = command.commands.map((c) => withIdsInCommand(c, keyed, relations));
  return out;
}

/**
 * The commands of the testing API, taking names where an instance is designated:
 * every entry of a `create` that has a `name` gets `uid(name)` as `id`, outside
 * the schemas of the model, and the values of the properties in `relations` are
 * names read as ids, in entries and filters.
 */
export function idCommands(relations: readonly string[]): {
  runCommand: typeof runRawCommand;
  runScript: typeof runRawScript;
  createApiSession: typeof createRawApiSession;
} {
  const keyed = new Set(["*"]);
  const rels = new Set(relations);
  const turn = <T>(command: T): T => withIdsInCommand(command, keyed, rels) as T;
  return {
    runCommand: ((locator: string, command: never) => runRawCommand(locator, turn(command))) as typeof runRawCommand,
    runScript: ((locator: string, script: never, ...rest: never[]) => (runRawScript as (...a: unknown[]) => unknown)(locator, turn(script), ...rest)) as typeof runRawScript,
    createApiSession: (() => {
      const session = createRawApiSession();
      const run = session.runCommand.bind(session);
      session.runCommand = ((locator: string, command: never) => run(locator, turn(command))) as typeof session.runCommand;
      return session;
    }) as typeof createRawApiSession,
  };
}
