/**
 * What the entries of the workspace share: a document, its transactions and its
 * undo, wherever its sections are kept. Nothing from Node is reached from here.
 */

import { isLocalModule, moduleDigest, type Delta, type ModuleManifest, type TransientObject } from "@scfloworg/core";
import type { ActionOutcome, Environment, OpenDataset } from "@scfloworg/environment";
import type { ProjectFormat } from "@scfloworg/format-file/browser";
import { DOCUMENT_SECTIONS } from "@scfloworg/project-file";

const HISTORY_LIMIT = 50;
const VERSION_FIELDS = [
  "model_major_version",
  "model_minor_version",
  "data_major_version",
  "data_minor_version",
] as const;

/** The refusals of the workspace. */
export type WorkspaceErrorCode =
  | "unknown_format"
  | "transaction_open"
  | "no_transaction"
  | "reserved_section"
  | "read_only_document"
  | "document_open";

/** Every refusal of the workspace itself. */
export class WorkspaceError extends Error {
  constructor(
    readonly code: WorkspaceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceError";
  }
}

/** What a transaction function receives. */
export interface DocumentTransaction {
  run(id: string, params?: unknown): Promise<ActionOutcome>;
}

/** An open document, wherever its sections are kept. */
export interface BaseDocument {
  readonly locator: string;
  /** The dataset of the document, for reads. A write goes through the document, for its undo. */
  readonly dataset: OpenDataset;
  readonly readOnly: boolean;
  /** The modules whose embedded manifest does not match its digest. */
  readonly handEdited: readonly string[];
  type: string;
  title: string;
  /** The section `key`, or `undefined`. */
  section(key: string): unknown;
  /** Writes a section that does not belong to the dataset. */
  setSection(key: string, value: unknown): void;
  /** Runs an action, as one undo step, or as part of the open transaction. */
  run(id: string, params?: unknown): Promise<ActionOutcome>;
  /** Runs `body` in one transaction, rolled back if it throws. */
  transaction<T>(label: string, body: (tx: DocumentTransaction) => Promise<T>): Promise<T>;
  begin(label: string): Promise<void>;
  prepare(): Promise<{ changed: boolean }>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  /**
   * Adds an installed module and its missing dependencies, and gives the keys
   * added. It stays out of the undo history, and the steps of the history still
   * revert. Fails with `read_only_document` and `transaction_open`, and as
   * `addModule` of the dataset does.
   */
  addModule(key: string): Promise<string[]>;
  /** Undoes the last step, and gives `false` when there is none. */
  undo(): Promise<boolean>;
  /** Redoes the last undone step, and gives `false` when there is none. */
  redo(): Promise<boolean>;
  /** The labels of both stacks, the next step last. */
  history(): { undo: string[]; redo: string[] };
  /** Forgets the document. What was not saved is lost. */
  close(): Promise<void>;
}

/** What creating any document takes. */
export interface NewDocumentOptions {
  /** The keys of the installed modules; their dependencies are added. */
  modules: readonly string[];
  /** The type of document, as `publisher:type`. */
  type: string;
  title: string;
}

/** The checks a document gives an entry for what the entry adds to it. */
export interface DocumentGuards {
  refuseIfReadOnly(what: string): void;
  refuseIfOpen(what: string): void;
}

interface Step {
  label: string;
  delta: Delta;
}

/** The name of a dataset derived from `text`: an identifier. */
export function datasetNameOf(text: string): string {
  const name = text.replace(/[^A-Za-z0-9_]/g, "_");
  return /^[A-Za-z_]/.test(name) ? name : `project_${name}`;
}

/** The modules whose embedded manifest does not give the digest recorded for it. */
async function handEditedModules(sections: { get(key: string): unknown }): Promise<string[]> {
  const modules = (sections.get("modules") ?? {}) as Record<string, { digest?: string }>;
  const model = (sections.get("model") ?? {}) as Record<string, ModuleManifest>;
  const edited: string[] = [];
  for (const [key, entry] of Object.entries(modules)) {
    const manifest = model[key];
    if (isLocalModule(key) || manifest === undefined) continue;
    if ((await moduleDigest(manifest)) !== entry.digest) edited.push(key);
  }
  return edited;
}

/** What the entries of a workspace stand on. */
export interface DocumentHost<D extends BaseDocument> {
  environment: Environment;
  file: ProjectFormat;
  /** The open documents, by the key of the project in `file`. */
  documents: Map<string, D>;
}

/** Fails with `unknown_format` when `file` is not a format of `environment`. */
export function requireFormat(environment: Environment, file: ProjectFormat): void {
  if (!environment.formats.includes(file)) {
    throw new WorkspaceError("unknown_format", `The format "${file.name}" is not one of the environment`);
  }
}

/** The locator of the project at `key` in `file`. */
export function locatorOf(file: ProjectFormat, key: string): string {
  return `${file.name}:${key}`;
}

/**
 * Makes the document of the project at `path` and registers it. `extras` gives
 * what its entry adds to it.
 */
export function makeDocument<D extends BaseDocument>(
  host: DocumentHost<D>,
  path: string,
  dataset: OpenDataset,
  handEdited: string[],
  extras: (guards: DocumentGuards) => Omit<D, keyof BaseDocument>,
): D {
  const { file, documents } = host;
  const readOnly = dataset.readOnly || handEdited.length > 0;
  const undoStack: Step[] = [];
  const redoStack: Step[] = [];
  let open: { label: string; prepared: { changed: boolean; delta: Delta } | null } | null = null;

  const project = () => file.project(path);

  const refuseIfReadOnly = (what: string) => {
    if (readOnly) throw new WorkspaceError("read_only_document", `"${path}" is read only: ${what} is refused`);
  };
  const refuseIfOpen = (what: string) => {
    if (open) throw new WorkspaceError("transaction_open", `A transaction is open: ${what} is refused`);
  };
  const requireOpen = () => {
    if (!open) throw new WorkspaceError("no_transaction", "No transaction is open");
    return open;
  };

  function pushStep(step: Step): void {
    undoStack.push(step);
    if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
    redoStack.length = 0;
  }

  /**
   * A revert moves the data version, so the older deltas look stale to the
   * engine. The stack guarantees the data is as each delta expects it.
   */
  async function rebased(delta: Delta): Promise<Delta> {
    const info = (await dataset.info()) as TransientObject;
    const raw = delta as unknown as { versions?: Record<string, unknown> };
    if (!raw.versions) return delta;
    const versions = { ...raw.versions };
    for (const field of VERSION_FIELDS) if (typeof info[field] === "number") versions[field] = info[field];
    return { ...raw, versions } as unknown as Delta;
  }

  /** Reverts the top of `from`, and pushes on `to` the delta that goes back. */
  async function move(from: Step[], to: Step[]): Promise<boolean> {
    const step = from[from.length - 1];
    if (!step) return false;
    await dataset.begin(step.label);
    try {
      await dataset.revert(await rebased(step.delta));
      const { delta } = await dataset.prepare();
      await dataset.commit();
      from.pop();
      to.push({ label: step.label, delta });
      return true;
    } catch (error) {
      await dataset.rollback();
      throw error;
    }
  }

  async function run(id: string, params?: unknown): Promise<ActionOutcome> {
    if (open) {
      try {
        return await dataset.run(id, params);
      } catch (error) {
        // The environment rolled the whole transaction back.
        open = null;
        throw error;
      }
    }
    const outcome = await dataset.run(id, params);
    if (outcome.changed && outcome.delta) {
      const action = dataset.actions().find((candidate) => candidate.id === id);
      pushStep({ label: action?.title ?? id, delta: outcome.delta });
    }
    return outcome;
  }

  async function begin(label: string): Promise<void> {
    refuseIfReadOnly("a transaction");
    refuseIfOpen("a second transaction");
    open = { label, prepared: null };
    try {
      await dataset.begin(label);
    } catch (error) {
      open = null;
      throw error;
    }
  }

  async function prepare(): Promise<{ changed: boolean }> {
    const transaction = requireOpen();
    transaction.prepared = await dataset.prepare();
    return { changed: transaction.prepared.changed };
  }

  async function commit(): Promise<void> {
    const transaction = requireOpen();
    const prepared = transaction.prepared ?? (await dataset.prepare());
    await dataset.commit();
    open = null;
    if (prepared.changed) pushStep({ label: transaction.label, delta: prepared.delta });
  }

  async function rollback(): Promise<void> {
    requireOpen();
    await dataset.rollback();
    open = null;
  }

  const base: BaseDocument = {
    locator: dataset.locator,
    dataset,
    readOnly,
    handEdited: Object.freeze(handEdited) as readonly string[],
    get type() {
      return project().type;
    },
    set type(value: string) {
      project().type = value;
    },
    get title() {
      return project().title;
    },
    set title(value: string) {
      project().title = value;
    },
    section: (key) => project().sections.get(key),
    setSection(key, value) {
      refuseIfReadOnly("writing a section");
      if (DOCUMENT_SECTIONS.includes(key)) {
        throw new WorkspaceError("reserved_section", `Section "${key}" belongs to the dataset`);
      }
      project().sections.set(key, value);
    },
    run,
    async transaction(label, body) {
      await begin(label);
      try {
        const result = await body({ run });
        await commit();
        return result;
      } catch (error) {
        if (open) await rollback();
        throw error;
      }
    },
    async addModule(key) {
      refuseIfReadOnly("adding a module");
      refuseIfOpen("adding a module");
      return dataset.addModule(key);
    },
    begin,
    prepare,
    commit,
    rollback,
    async undo() {
      refuseIfReadOnly("undo");
      refuseIfOpen("undo");
      return move(undoStack, redoStack);
    },
    async redo() {
      refuseIfReadOnly("redo");
      refuseIfOpen("redo");
      return move(redoStack, undoStack);
    },
    history: () => ({
      undo: undoStack.map((step) => step.label),
      redo: redoStack.map((step) => step.label),
    }),
    async close() {
      if (open) await rollback();
      await dataset.close();
      file.release(path);
      documents.delete(path);
    },
  };
  // Assigned onto `base`, whose accessors a spread would freeze.
  const document = Object.assign(base, extras({ refuseIfReadOnly, refuseIfOpen })) as unknown as D;
  documents.set(path, document);
  return document;
}

/** Creates the document of a new project at `key`. */
export async function createDocument<D extends BaseDocument>(
  host: DocumentHost<D>,
  key: string,
  options: NewDocumentOptions & { name: string },
  extras: (guards: DocumentGuards) => Omit<D, keyof BaseDocument>,
): Promise<D> {
  const { environment, file } = host;
  const dataset = await environment.datasets.create({
    modules: options.modules,
    locator: locatorOf(file, key),
    name: options.name,
  });
  const project = file.project(key);
  project.type = options.type;
  project.title = options.title;
  return makeDocument(host, key, dataset, [], extras);
}

/** Opens the project at `key`, which `file` can read. */
export async function openDocument<D extends BaseDocument>(
  host: DocumentHost<D>,
  key: string,
  readOnly: boolean,
  extras: (guards: DocumentGuards) => Omit<D, keyof BaseDocument>,
): Promise<D> {
  const { environment, file } = host;
  // The digests are checked on the file as it was read, before an upgrade changes it.
  await file.datasetExists(key);
  const handEdited = await handEditedModules(file.project(key).sections);
  const dataset = await environment.datasets.open(locatorOf(file, key), {
    readOnly: readOnly || handEdited.length > 0,
  });
  return makeDocument(host, key, dataset, handEdited, extras);
}
