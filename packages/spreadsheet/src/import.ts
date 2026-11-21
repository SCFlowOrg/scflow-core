import {
  hasNameScope,
  nameScopeOf,
  qualifiedName,
  resolveReferenceIn,
  type AuthoredCommand,
  type DatasetModel,
  type NamedInstance,
  type NamedInstances,
  type NormalizedSchema,
  type TransientObject,
} from "@scfloworg/core";
import { DEFAULT_SEPARATOR, isBlank, parseScalar, sameValue, splitList } from "./cells.js";
import { readValue } from "./export.js";
import { layoutOf, splitQualified, type ColumnSpec, type Layout } from "./layout.js";
import { loadContext, loadIndex, sheetNames, sheetSchemas, shortName } from "./model.js";
import { createActionOf, signatureOf, updateActionOf, violationOf, type Signature } from "./params.js";
import {
  SpreadsheetError,
  type CellValue,
  type ImportError,
  type ImportOptions,
  type ImportReport,
  type Row,
  type RowReport,
  type RowStatus,
  type Sheet,
  type SpreadsheetDataset,
} from "./types.js";

interface Problem {
  code: string;
  message: string;
}

/** A relation of a row to another row of the import that creates its target: the target is written first. */
interface Dependency {
  target: Plan;
  property: string;
  /** A mandatory relation, or one of the scope: it cannot be written after the row. */
  hard: boolean;
}

/** What a column holds for a row once read: its property, the cell, and the value the cell gives. */
interface Cell {
  spec: ColumnSpec;
  blank: boolean;
  value?: unknown;
}

/** One row of one sheet, as the import plans it. */
interface Plan {
  title: string;
  schema: NormalizedSchema;
  layout: Layout;
  line: number;
  row: Row;
  headers: Map<ColumnSpec, string>;
  problems: Problem[];
  /** Every text of the name, in every language the row gives. */
  nameTexts: string[];
  /** The name as the row gives it: a text, or a map of language to text. */
  name?: string | Record<string, string>;
  /** The key of the entity: the existing one, or a temporary key of an entity this import creates. */
  key?: string;
  creating: boolean;
  existing?: TransientObject;
  cells: Cell[];
  /** The key a relation cell resolves to, by property. */
  relations: Map<string, string | null>;
  dependencies: Dependency[];
  /** The relations written after the creations, to break a cycle. */
  deferred: Set<string>;
  changes: string[];
  status: RowStatus;
  ops: Op[];
  /** The writes of the relations deferred, which run after every creation. */
  late: Op[];
  /** The id of the entity a create action returned. */
  createdId?: string;
}

/** One call of an action. */
interface Op {
  plan: Plan;
  action: string;
  params: Record<string, unknown>;
}

const TEMPORARY = "planned:";
const isTemporary = (key: string): boolean => key.startsWith(TEMPORARY);

const codeOf = (error: unknown): string => (error as { code?: unknown } | null)?.code as string ?? "action_failed";
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The topmost schema of the `extends` chain of `schema` that has a `name_scope`: names are unique within a family. */
function familyOf(model: DatasetModel, schema: NormalizedSchema): string {
  let current = schema;
  while (current.extends) {
    const parent = model.schemas.get(current.extends);
    if (!parent || !hasNameScope(parent)) break;
    current = parent;
  }
  return current.name;
}

const stringOf = (cell: CellValue): string => (typeof cell === "string" ? cell : String(cell));

/**
 * Imports sheets into a dataset. Every row is read and checked first, against
 * the schemas of the installed modules: a name is looked up in its scope, so
 * an existing name is an update and a new one a creation; a reference is
 * resolved (an id, or a name as short as it stays unambiguous, in any
 * language); a value is checked against the signature of the action that will
 * write it. The writes are then made by the `create_*` and `update_*` actions
 * of the model (`crud`), so its rules and its integrity apply, in the order
 * the relations ask for, in one transaction. A refused row refuses the
 * import: nothing is written, and the report lists every row with its reason.
 * An import never deletes.
 */
export async function importSheets(dataset: SpreadsheetDataset, sheets: readonly Sheet[], options: ImportOptions = {}): Promise<ImportReport> {
  if (options.dryRun === true && options.transaction === "caller") {
    throw new SpreadsheetError("dry_run_needs_own_transaction", "a dry run rolls its transaction back, so it needs `transaction: \"own\"`");
  }
  const separator = options.listSeparator ?? DEFAULT_SEPARATOR;
  const { model, languages } = await loadContext(dataset);
  const all = await loadIndex(dataset, model);
  const resolvers = { schemas: model.schemas, importNamespaces: [] } as never;
  const schemas = sheetSchemas(model);
  const titles = sheetNames(schemas);
  const errors: ImportError[] = [];
  const plans: Plan[] = [];
  const instances = new Map<string, Map<string, TransientObject>>();

  const instancesOf = async (schema: NormalizedSchema): Promise<Map<string, TransientObject>> => {
    let found = instances.get(schema.name);
    if (!found) {
      found = new Map(((await dataset.query({ query: schema.name } as AuthoredCommand)).after as TransientObject[]).map((i) => [i.id as string, i]));
      instances.set(schema.name, found);
    }
    return found;
  };

  // 1. The sheets: which schema, which column is which property.
  for (const sheet of sheets) {
    const wanted = sheet.schema ?? sheet.name;
    const exact = schemas.filter((s) => s.name === wanted);
    const matches = exact.length > 0 ? exact : schemas.filter((s) => shortName(s.name) === wanted);
    const fail = (code: string, message: string): void => {
      errors.push({ sheet: sheet.name, code, message });
    };
    let sheetError: ImportError | undefined;
    const sheetRefuse = (code: string, message: string): void => {
      fail(code, message);
      sheetError ??= { sheet: sheet.name, code, message };
    };
    let layout: Layout | undefined;
    const headers = new Map<ColumnSpec, string>();
    if (matches.length === 0) sheetRefuse("unknown_sheet", `no schema "${wanted}" is referred to by name; the sheets are ${schemas.map((s) => titles.get(s.name)).join(", ")}`);
    else if (matches.length > 1) sheetRefuse("unknown_sheet", `"${wanted}" names several schemas: ${matches.map((s) => s.name).join(", ")}; use the qualified name`);
    else {
      layout = layoutOf(model, matches[0], languages);
      const byHeader = new Map(layout.columns.map((c) => [c.header, c]));
      const aliases = new Map(layout.columns.filter((c) => c.kind === "localized" && c.language === languages[0]).map((c) => [c.property.name, c]));
      for (const raw of sheet.columns) {
        const header = raw.trim();
        if (header === "") continue;
        const spec = byHeader.get(header) ?? aliases.get(header);
        if (!spec) sheetRefuse("unknown_column", `unknown column "${header}"; the columns of "${titles.get(matches[0].name)}" are ${layout.columns.map((c) => c.header).join(", ")}`);
        else if (headers.has(spec)) sheetRefuse("duplicate_column", `the column "${spec.header}" is given twice`);
        else headers.set(spec, raw);
      }
      if (![...headers.keys()].some((c) => c.property.name === "name")) sheetRefuse("missing_name", `the sheet has no column "name": rows are found by their name`);
    }
    for (const [index, row] of sheet.rows.entries()) {
      if (Object.values(row).every(isBlank)) continue; // a blank line, as a spreadsheet leaves at its end
      const plan: Plan = {
        title: sheet.name,
        schema: matches[0] ?? ({ name: wanted } as NormalizedSchema),
        layout: layout as Layout,
        line: index + 2,
        row,
        headers,
        problems: sheetError ? [{ code: sheetError.code, message: `the sheet is refused: ${sheetError.message}` }] : [],
        nameTexts: [],
        creating: false,
        cells: [],
        relations: new Map(),
        dependencies: [],
        deferred: new Set(),
        changes: [],
        status: "refused",
        ops: [],
        late: [],
      };
      plans.push(plan);
    }
  }

  const live = () => plans.filter((p) => p.problems.length === 0);
  const refuse = (plan: Plan, code: string, message: string) => plan.problems.push({ code, message });

  // 2. The cells of each row: the values the columns give.
  for (const plan of live()) {
    const localized = new Map<string, Record<string, string | null>>();
    const localizedSpec = new Map<string, ColumnSpec>();
    for (const [spec, header] of plan.headers) {
      const cell = plan.row[header] ?? null;
      const blank = isBlank(cell);
      const where = `column "${spec.header}"`;
      if (spec.kind === "localized") {
        const map = localized.get(spec.property.name) ?? {};
        map[spec.language as string] = blank ? null : stringOf(cell).trim() === "" ? null : (spec.property.name === "name" ? stringOf(cell).trim() : stringOf(cell));
        localized.set(spec.property.name, map);
        localizedSpec.set(spec.property.name, spec);
        continue;
      }
      if (blank) {
        plan.cells.push({ spec, blank: true });
        continue;
      }
      if (spec.kind === "relation") {
        plan.cells.push({ spec, blank: false, value: stringOf(cell).trim() });
      } else if (spec.kind === "list") {
        const values: unknown[] = [];
        for (const part of splitList(cell, separator)) {
          const parsed = parseScalar(part, spec.base ?? "string");
          if ("error" in parsed) refuse(plan, "invalid_value", `${where}: ${parsed.error}`);
          else values.push(parsed.value);
        }
        plan.cells.push({ spec, blank: false, value: values });
      } else {
        const parsed = parseScalar(spec.property.name === "name" ? stringOf(cell).trim() : cell, spec.base ?? "string");
        if ("error" in parsed) refuse(plan, "invalid_value", `${where}: ${parsed.error}`);
        else plan.cells.push({ spec, blank: false, value: parsed.value });
      }
    }
    for (const [property, map] of localized) {
      const spec = localizedSpec.get(property) as ColumnSpec;
      plan.cells.push({ spec, blank: Object.values(map).every((t) => t === null), value: map });
    }
    const name = plan.cells.find((c) => c.spec.property.name === "name");
    if (!name || name.blank) {
      refuse(plan, "missing_name", `the name is empty: a row is found by its name`);
      continue;
    }
    if (name.spec.kind === "localized") {
      const map = name.value as Record<string, string | null>;
      plan.nameTexts = Object.values(map).filter((t): t is string => t !== null);
      plan.name = Object.fromEntries(Object.entries(map).filter((e): e is [string, string] => e[1] !== null));
    } else {
      plan.nameTexts = [name.value as string];
      plan.name = name.value as string;
    }
    const slash = plan.nameTexts.find((t) => t.includes("/"));
    if (slash !== undefined) refuse(plan, "invalid_value", `the name ${JSON.stringify(slash)} contains "/", which separates the parts of a qualified name`);
  }

  // 3. Which entity each row is: found by its name in its scope, else created. A scope can be another row of the
  //    import, so the rows are placed as their scopes resolve, the others on the next round.
  const plannedBy = new Map<string, Plan>();
  let counter = 0;
  const scopeOf = (plan: Plan): { key: string | null; specified: boolean } => {
    for (const relation of nameScopeOf(plan.schema)) {
      const cell = plan.cells.find((c) => c.spec.property.name === relation);
      if (!cell || cell.blank || cell.spec.target === undefined) continue;
      return { key: resolveReferenceIn(all, resolvers, cell.value as string, { schema: cell.spec.target.name, languages }).key, specified: true };
    }
    return { key: null, specified: false };
  };
  const place = async (plan: Plan): Promise<void> => {
    const scope = scopeOf(plan);
    const family = familyOf(model, plan.schema);
    const found = [...all.values()].filter(
      (i) => i.family === family && i.names.some((t) => plan.nameTexts.includes(t)) && (!scope.specified || i.scope === scope.key),
    );
    if (found.length > 1) {
      const candidates = found.map((i) => qualifiedName(i, all, languages)).sort();
      plan.problems.push({ code: "ambiguous_reference", message: `the name matches ${found.length} entities: ${candidates.map((c) => `"${c}"`).join(", ")}; give the scope` });
      return;
    }
    if (found.length === 1) {
      const entity = found[0];
      const earlier = plannedBy.get(entity.key);
      if (earlier) {
        plan.problems.push({ code: "duplicate_row", message: `it is the same entity as line ${earlier.line} of "${earlier.title}"` });
        return;
      }
      if (entity.schema !== plan.schema.name) {
        plan.problems.push({ code: "duplicate_row", message: `its name is used by a "${shortName(entity.schema)}", which is of the same family` });
        return;
      }
      plan.key = entity.key;
      plan.existing = (await instancesOf(plan.schema)).get(entity.key);
      return;
    }
    const key = `${TEMPORARY}${++counter}`;
    const node: NamedInstance = { schema: plan.schema.name, key, family, names: plan.nameTexts, name: plan.name as never, scope: scope.key, imported: false };
    all.set(key, node);
    plannedBy.set(key, plan);
    plan.key = key;
    plan.creating = true;
  };
  let pending = live();
  const last = new Map<Plan, unknown>();
  for (let progress = true; progress && pending.length > 0; ) {
    progress = false;
    for (const plan of [...pending]) {
      try {
        await place(plan);
        pending = pending.filter((p) => p !== plan);
        progress = true;
      } catch (error) {
        last.set(plan, error);
      }
    }
  }
  for (const plan of pending) refuse(plan, codeOf(last.get(plan)), messageOf(last.get(plan)));

  // 4. The references, now that every row that creates an entity is known; the rows they point at.
  for (const plan of live()) {
    const scope = new Set(nameScopeOf(plan.schema));
    for (const cell of plan.cells) {
      if (cell.spec.kind !== "relation") continue;
      const property = cell.spec.property.name;
      if (cell.blank) {
        plan.relations.set(property, null);
        continue;
      }
      try {
        const key = resolveReferenceIn(all, resolvers, cell.value as string, { schema: (cell.spec.target as NormalizedSchema).name, languages }).key;
        plan.relations.set(property, key);
        const target = plannedBy.get(key);
        if (target) plan.dependencies.push({ target, property, hard: cell.spec.property.constraints.mandatory === true || scope.has(property) });
      } catch (error) {
        refuse(plan, codeOf(error), `column "${cell.spec.header}": ${messageOf(error)}`);
      }
    }
  }

  // 5. The order of the writes: an entity after the entities it needs. An optional relation that closes a cycle is
  //    written after the creations; a cycle of mandatory ones cannot be written.
  const order: Plan[] = [];
  const state = new Map<Plan, 1 | 2>();
  const describe = (plan: Plan): string => (plan.key !== undefined && all.has(plan.key) ? qualifiedName(all.get(plan.key) as NamedInstance, all, languages) : plan.nameTexts[0] ?? "?");
  const visit = (plan: Plan, path: Plan[]): void => {
    state.set(plan, 1);
    for (const dependency of [...plan.dependencies].sort((a, b) => Number(b.hard) - Number(a.hard))) {
      const target = dependency.target;
      if (target.problems.length > 0) continue;
      const seen = state.get(target);
      if (seen === 2) continue;
      if (seen === 1) {
        if (!dependency.hard) {
          plan.deferred.add(dependency.property);
          continue;
        }
        const cycle = [...path, plan].slice([...path, plan].indexOf(target));
        const text = [...cycle, target].map(describe).join(" → ");
        for (const member of cycle) refuse(member, "dependency_cycle", `mandatory references form a cycle: ${text}`);
        continue;
      }
      visit(target, [...path, plan]);
    }
    state.set(plan, 2);
    order.push(plan);
  };
  for (const plan of live()) if (!state.has(plan)) visit(plan, []);

  // 6. The calls: what each row writes, checked against the signature of the action.
  const signatures = new Map<string, Signature | undefined>();
  const signature = (id: string | undefined): Signature | undefined => {
    if (id !== undefined && !signatures.has(id)) signatures.set(id, signatureOf(dataset, id));
    return id === undefined ? undefined : signatures.get(id);
  };
  const argument = (key: string): string => (isTemporary(key) ? qualifiedName(all.get(key) as NamedInstance, all, languages) : key);

  for (const plan of order.filter((p) => p.problems.length === 0)) {
    buildOps(plan);
    if (plan.problems.length > 0) continue;
    plan.status = plan.creating ? "create" : plan.changes.length > 0 ? "update" : "unchanged";
  }

  function buildOps(plan: Plan): void {
    const main = new Map<string, unknown>();
    const facets = new Map<string, Map<string, unknown>>();
    const deferred = new Map<string, unknown>();
    const write = (cell: Cell, value: unknown): void => {
      const spec = cell.spec;
      const property = spec.property.name;
      if (spec.facet !== undefined) {
        const values = facets.get(spec.facet) ?? new Map<string, unknown>();
        values.set(splitQualified(property).short, value);
        facets.set(spec.facet, values);
      } else if (spec.kind === "relation" && plan.deferred.has(property)) deferred.set(property, value);
      else main.set(property, value);
      if (!plan.changes.includes(property)) plan.changes.push(property);
    };
    for (const cell of plan.cells) {
      const spec = cell.spec;
      const property = spec.property.name;
      const current = plan.existing ? readValue(plan.existing, spec) : undefined;
      let value: unknown;
      if (spec.kind === "relation") {
        const key = plan.relations.get(property) ?? null;
        if (plan.creating) value = key === null ? undefined : argument(key);
        else if (key === null) value = current === null || current === undefined ? undefined : null;
        else value = key === current ? undefined : argument(key);
      } else if (spec.kind === "localized") {
        const map = cell.value as Record<string, string | null>;
        if (plan.creating) {
          const given = Object.fromEntries(Object.entries(map).filter((e): e is [string, string] => e[1] !== null));
          value = Object.keys(given).length > 0 ? given : undefined;
        } else {
          const merged: Record<string, string> = { ...((current as Record<string, string> | undefined) ?? {}) };
          for (const [language, text] of Object.entries(map)) {
            if (text !== null) merged[language] = text;
            else if (property !== "name") delete merged[language]; // the name identifies the entity: an empty cell never removes a language of it
          }
          value = sameValue(merged, (current as Record<string, string> | undefined) ?? {}) ? undefined : merged;
        }
      } else if (spec.kind === "list") {
        const list = cell.blank ? [] : (cell.value as unknown[]);
        const normalise = (v: unknown) => (Array.isArray(v) && spec.property.constraints.is_set === true ? [...v].sort() : v);
        value = plan.creating ? (list.length > 0 ? list : undefined) : sameValue(normalise(list), normalise(current ?? [])) ? undefined : list;
      } else {
        const next = cell.blank ? null : cell.value;
        if (plan.creating) value = cell.blank ? undefined : next;
        else if (cell.blank) value = current === null || current === undefined || current === "" ? undefined : null;
        else value = sameValue(next, current ?? null) ? undefined : next;
      }
      if (value === undefined) continue;
      if (!plan.creating && value === null && spec.property.constraints.mandatory === true) {
        refuse(plan, "invalid_value", `column "${spec.header}": "${property}" is mandatory and cannot be emptied`);
        continue;
      }
      write(cell, value);
    }

    const create = plan.creating ? signature(createActionOf(plan.schema)) : undefined;
    const update = signature(updateActionOf(plan.schema));
    const target = plan.creating ? create : update;
    const verb = plan.creating ? "create" : "update";
    if ((plan.creating || main.size > 0) && !target) {
      refuse(plan, "no_action", `the model has no action to ${verb} "${shortName(plan.schema.name)}": its crud does not offer one`);
      return;
    }
    const checkParams = (id: Signature, params: Map<string, unknown>, who: string): void => {
      for (const [name, value] of params) {
        if (!(name in id.properties)) {
          refuse(plan, "not_writable", `"${name}" cannot be written by ${id.id}${who}`);
          continue;
        }
        const reason = violationOf(id.properties[name] as Record<string, unknown>, value);
        if (reason !== null) refuse(plan, "invalid_value", `"${name}": ${reason}`);
      }
    };
    if (target && (plan.creating || main.size > 0)) {
      checkParams(target, main, "");
      if (plan.creating) {
        for (const required of target.required) {
          if (!main.has(required) && !deferred.has(required)) refuse(plan, "missing_required", `"${required}" is required to create "${shortName(plan.schema.name)}": give a value in the column "${required}"`);
        }
      }
    }
    if (plan.problems.length > 0) return;
    if (target && (plan.creating || main.size > 0)) {
      plan.ops.push({ plan, action: target.id, params: plan.creating ? Object.fromEntries(main) : { id: plan.key, ...Object.fromEntries(main) } });
    }
    for (const [facet, values] of facets) {
      const schema = model.schemas.get(facet) as NormalizedSchema;
      const action = signature(updateActionOf(schema));
      if (!action) {
        refuse(plan, "no_action", `the model has no action to update the facet "${facet}"`);
        return;
      }
      checkParams(action, values, "");
      if (plan.problems.length > 0) return;
      plan.ops.push({ plan, action: action.id, params: { id: plan.creating ? argument(plan.key as string) : plan.key, ...Object.fromEntries(values) } });
    }
    if (deferred.size > 0) {
      const action = update ?? signature(updateActionOf(plan.schema));
      if (!action) {
        refuse(plan, "no_action", `the model has no action to update "${shortName(plan.schema.name)}", which a cycle of references needs`);
        return;
      }
      checkParams(action, deferred, "");
      if (plan.problems.length > 0) return;
      plan.late.push({ plan, action: action.id, params: { id: argument(plan.key as string), ...Object.fromEntries(deferred) } });
    }
  }

  // 7. The report, and the writes.
  const report = (extra: Partial<ImportReport> = {}): ImportReport => {
    const rows: RowReport[] = plans.map((plan) => {
      const reason = plan.problems.map((p) => p.message).join("; ");
      const entry: RowReport = {
        sheet: plan.title,
        line: plan.line,
        name: plan.key !== undefined && all.has(plan.key) ? describe(plan) : plan.nameTexts[0] ?? "",
        status: plan.problems.length > 0 ? "refused" : plan.status,
      };
      if (plan.problems.length > 0) {
        entry.reason = reason;
        entry.code = plan.problems[0].code;
      } else if (plan.status === "update") entry.changes = [...plan.changes];
      return entry;
    });
    const count = (status: RowStatus) => rows.filter((r) => r.status === status).length;
    const titlesInOrder = [...new Set([...order.filter((p) => p.ops.length > 0).map((p) => p.title), ...plans.map((p) => p.title)])];
    const refused = count("refused");
    return {
      ok: refused === 0 && count("not_run") === 0 && errors.length === 0,
      dryRun: options.dryRun === true,
      applied: false,
      created: count("create"),
      updated: count("update"),
      unchanged: count("unchanged"),
      refused,
      rows,
      errors,
      order: titlesInOrder,
      ...extra,
    };
  };

  if (plans.some((p) => p.problems.length > 0) || errors.length > 0) return report();
  const ops = [...order.flatMap((p) => p.ops), ...order.flatMap((p) => p.late)];
  if (ops.length === 0) return report();

  const own = options.transaction !== "caller";
  if (own) await dataset.begin(options.label ?? "Import sheets");
  const rollback = async (): Promise<void> => {
    if (!own) return;
    try {
      await dataset.rollback();
    } catch {
      // the environment already rolled the transaction back when an action failed
    }
  };
  let done = 0;
  try {
    for (const op of ops) {
      const outcome = await dataset.run(op.action, op.params);
      const result = outcome.result as { id?: unknown } | null;
      if (op.plan.creating && op.plan.createdId === undefined && result !== null && typeof result === "object" && typeof result.id === "string") op.plan.createdId = result.id;
      done += 1;
    }
  } catch (error) {
    const failed = ops[done].plan;
    failed.problems.push({ code: codeOf(error), message: messageOf(error) });
    for (const plan of order) if (plan !== failed && plan.problems.length === 0 && order.indexOf(plan) > order.indexOf(failed) && (plan.ops.length > 0 || plan.late.length > 0)) plan.status = "not_run";
    await rollback();
    return report();
  }
  if (!own) return report({ applied: true });
  try {
    const prepared = (await dataset.prepare()) as { delta?: unknown } | undefined;
    if (options.dryRun === true) {
      await rollback();
      return report();
    }
    await dataset.commit();
    return report({ applied: true, delta: prepared?.delta });
  } catch (error) {
    await rollback();
    const violations = ((error as { details?: { violations?: { rule: string; schema: string; key: string }[] } }).details?.violations ?? []);
    let matched = 0;
    for (const violation of violations) {
      const plan = plans.find((p) => p.key === violation.key || p.createdId === violation.key);
      if (!plan) continue;
      plan.problems.push({ code: codeOf(error), message: `it breaks the rule "${violation.rule}" of "${shortName(violation.schema)}"` });
      matched += 1;
    }
    if (matched === 0) errors.push({ code: codeOf(error), message: messageOf(error) });
    return report();
  }
}
