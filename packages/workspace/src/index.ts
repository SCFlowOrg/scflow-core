/**
 * The workspace: documents, their sections, transactions and undo, over an
 * environment and the `file` format, with no UI (see `docs/workspace.md`).
 */

import { isLocalModule, moduleDigest, type Delta, type ModuleManifest, type TransientObject } from "@scfloworg/core";
import type { ActionOutcome, Environment, OpenDataset } from "@scfloworg/environment";
import type { FileFormat } from "@scfloworg/format-file";
import { DOCUMENT_SECTIONS } from "@scfloworg/project-file";
import type { WriteProjectResult } from "@scfloworg/project-file/node";
import { basename, resolve } from "node:path";

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
  | "read_only_document";

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

/** An open document. */
export interface Document {
  /** The absolute path of the project. */
  readonly path: string;
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
  /** Undoes the last step, and gives `false` when there is none. */
  undo(): Promise<boolean>;
  /** Redoes the last undone step, and gives `false` when there is none. */
  redo(): Promise<boolean>;
  /** The labels of both stacks, the next step last. */
  history(): { undo: string[]; redo: string[] };
  save(): Promise<WriteProjectResult>;
  /** Forgets the document. What was not saved is lost. */
  close(): Promise<void>;
}

/** What `workspace.create` takes. */
export interface CreateDocumentOptions {
  path: string;
  /** The keys of the installed modules; their dependencies are added. */
  modules: readonly string[];
  /** The type of document, as `publisher:type`. */
  type: string;
  title: string;
  /** The name of the dataset, an identifier; derived from the path by default. */
  name?: string;
}

/** The documents of a host. */
export interface Workspace {
  create(options: CreateDocumentOptions): Promise<Document>;
  open(path: string, options?: { readOnly?: boolean }): Promise<Document>;
  get(path: string): Document | undefined;
  list(): Document[];
}

/** What `createWorkspace` takes. */
export interface WorkspaceOptions {
  environment: Environment;
  /** The format that holds the projects, one of the formats of `environment`. */
  file: FileFormat;
}

interface Step {
  label: string;
  delta: Delta;
}

function datasetNameOf(path: string): string {
  const name = basename(path, ".json").replace(/[^A-Za-z0-9_]/g, "_");
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

/** Creates a workspace. Fails with `unknown_format` when `file` is not a format of `environment`. */
export function createWorkspace(options: WorkspaceOptions): Workspace {
  const { environment, file } = options;
  if (!environment.formats.includes(file)) {
    throw new WorkspaceError("unknown_format", `The format "${file.name}" is not one of the environment`);
  }
  const documents = new Map<string, Document>();
  const opening = new Map<string, Promise<Document>>();

  const locatorOf = (path: string) => `${file.name}:${path}`;

  function makeDocument(path: string, dataset: OpenDataset, handEdited: string[]): Document {
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

    const document: Document = {
      path,
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
      async save() {
        refuseIfReadOnly("save");
        refuseIfOpen("save");
        return file.save(path);
      },
      async close() {
        if (open) await rollback();
        await dataset.close();
        file.release(path);
        documents.delete(path);
      },
    };
    documents.set(path, document);
    return document;
  }

  async function openDocument(path: string, readOnly: boolean): Promise<Document> {
    const locator = locatorOf(path);
    // The digests are checked on the file as it was read, before an upgrade changes it.
    await file.datasetExists(path);
    const handEdited = await handEditedModules(file.project(path).sections);
    const dataset = await environment.datasets.open(locator, { readOnly: readOnly || handEdited.length > 0 });
    return makeDocument(path, dataset, handEdited);
  }

  return {
    async create({ path: given, modules, type, title, name }) {
      const path = resolve(given);
      const dataset = await environment.datasets.create({
        modules,
        locator: locatorOf(path),
        name: name ?? datasetNameOf(path),
      });
      const project = file.project(path);
      project.type = type;
      project.title = title;
      return makeDocument(path, dataset, []);
    },
    open(given, openOptions = {}) {
      const path = resolve(given);
      const known = documents.get(path);
      if (known) return Promise.resolve(known);
      let pending = opening.get(path);
      if (!pending) {
        pending = openDocument(path, openOptions.readOnly === true).finally(() => opening.delete(path));
        opening.set(path, pending);
      }
      return pending;
    },
    get: (path) => documents.get(resolve(path)),
    list: () => [...documents.values()],
  };
}
