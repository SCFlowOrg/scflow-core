/**
 * Pure runtime of `core-plugin`: one MCL dataset per document, a shared
 * built-in holding every plugin's schemas, undo / redo through core
 * transactions, and a filtered `MclAccess`. No kernel, no React: testable
 * with `bun test`.
 */
import {
  createApiSession,
  createUpgradeLocator,
  initDataset,
  registerPersistentFormat,
  restoreDataset,
  runCommand,
  upgradeDataset,
  type ApiSession,
  type AuthoredCommand,
  type AuthoredScript,
  type CommandResult,
  type MclAccess,
  type ModelActionDefinition,
  type TransactionId,
} from "@scfloworg/core";
import { jsFormat } from "@scfloworg/format-js/browser";
import type { SchemaPackage } from "./types.js";

export type * from "./types.js";

/** Same shape as `DocumentHistory` of `documents` (structural, no kernel import). */
export interface CoreHistory {
  begin(docId: string, label?: string): Promise<void>;
  prepare(docId: string): Promise<{ changed: boolean; delta: unknown | null }>;
  commit(docId: string): Promise<void>;
  rollback(docId: string): Promise<void>;
  revert(docId: string, delta: unknown): Promise<void>;
}

export interface CoreRuntime {
  readonly builtin: string;
  readonly session: ApiSession;
  readonly mcl: MclAccess;
  readonly history: CoreHistory;
  init(): Promise<void>;
  locatorOf(docId: string): string;
  isOpen(docId: string): boolean;
  onChange(docId: string | null, listener: (docId: string) => void): () => void;
  registerSchemas(pluginId: string, schemas: SchemaPackage | Record<string, unknown>[]): Promise<void>;
  /** Register model actions; an action registered again under the same id replaces the previous one. */
  registerModelActions(actions: ModelActionDefinition[]): void;
  /** The registered model actions, in registration order. */
  getModelActions(): readonly ModelActionDefinition[];
  /**
   * Run a registered action on an open document. Inside an open document
   * transaction (a handler of the shell), the action joins it and the caller
   * commits or rolls back; otherwise the action runs in a transaction of its own.
   * An action declared `kind: "read"` runs outside any transaction, never
   * commits or rolls back and notifies no `onChange` listener.
   */
  runModelAction<TResult = unknown>(
    docId: string,
    actionId: string,
    params: Record<string, unknown>,
  ): Promise<TResult>;
  createDocument(docId: string): Promise<string>;
  loadDocument(docId: string, data: unknown): Promise<string>;
  saveDocument(docId: string): Promise<unknown>;
  disposeDocument(docId: string): Promise<void>;
}

export class CoreAccessError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

const KINDS = ["query", "create", "update", "delete"] as const;

export function commandKind(command: AuthoredCommand): string | undefined {
  const value = command as Record<string, unknown>;
  if (typeof value.kind === "string") return value.kind;
  return KINDS.find((k) => k in value);
}

export interface CoreRuntimeOptions {
  /** Area of the `js` format; one built-in per area. Default "app". */
  area?: string;
}

let formatRegistered = false;

export function createCoreRuntime(options: CoreRuntimeOptions = {}): CoreRuntime {
  const area = options.area ?? "app";
  const builtin = `js:${area}`;
  const session = createApiSession();
  const open = new Map<string, string>(); // docId -> locator
  const byLocator = new Map<string, string>(); // locator -> docId
  const transactions = new Map<string, TransactionId>(); // docId -> open tx
  const listeners = new Map<string | null, Set<(docId: string) => void>>();
  const schemaOwners = new Map<string, string>();
  let schemaQueue: Promise<unknown> = Promise.resolve();

  const docLocator = (docId: string) => `${builtin}/${encodeURIComponent(docId)}`;

  function notify(docId: string) {
    for (const key of [docId, null]) {
      for (const fn of listeners.get(key) ?? []) {
        try {
          fn(docId);
        } catch (error) {
          console.error("[core-plugin] change listener failed", error);
        }
      }
    }
  }

  function locatorOf(docId: string): string {
    const locator = open.get(docId);
    if (!locator) throw new CoreAccessError("document_not_open", `Document "${docId}" is not open`);
    return locator;
  }

  function checkLocator(locator: string, readOnlyQuery: boolean): string | null {
    if (locator === builtin) {
      if (readOnlyQuery) return null;
      throw new CoreAccessError("read_only", "The built-in dataset is read-only: register schemas instead");
    }
    const docId = byLocator.get(locator);
    if (docId === undefined) {
      throw new CoreAccessError("locator_refused", `Locator "${locator}" is not an open document`);
    }
    return docId;
  }

  const mcl: MclAccess = {
    async runCommand(locator: string, command: AuthoredCommand): Promise<CommandResult> {
      const isQuery = commandKind(command) === "query";
      const docId = checkLocator(locator, isQuery);
      const result = await session.runCommand(locator, command);
      if (docId !== null && !isQuery && !transactions.has(docId)) notify(docId);
      return result;
    },
    async runScript(locator: string, script: AuthoredScript): Promise<CommandResult> {
      const docId = checkLocator(locator, false);
      const result = await session.runScript(locator, script);
      if (docId !== null && !transactions.has(docId)) notify(docId);
      return result;
    },
  };

  const history: CoreHistory = {
    async begin(docId, label) {
      const locator = open.get(docId);
      if (!locator) return;
      transactions.set(docId, await session.beginTransaction(locator, label));
    },
    async prepare(docId) {
      const locator = open.get(docId);
      const tx = transactions.get(docId);
      if (!locator || tx === undefined) return { changed: false, delta: null };
      const prepared = await session.prepareTransaction(locator, tx);
      return { changed: prepared.changed, delta: prepared.changed ? prepared.delta : null };
    },
    async commit(docId) {
      const locator = open.get(docId);
      const tx = transactions.get(docId);
      transactions.delete(docId);
      if (!locator || tx === undefined) return;
      await session.commitTransaction(locator, tx);
      notify(docId);
    },
    async rollback(docId) {
      const locator = open.get(docId);
      const tx = transactions.get(docId);
      transactions.delete(docId);
      if (!locator || tx === undefined) return;
      await session.rollbackTransaction(locator, tx);
      notify(docId);
    },
    async revert(docId, delta) {
      await session.revert(locatorOf(docId), delta as never);
    },
  };

  const modelActions = new Map<string, ModelActionDefinition>();

  async function runModelAction<TResult = unknown>(
    docId: string,
    actionId: string,
    params: Record<string, unknown>,
  ): Promise<TResult> {
    const action = modelActions.get(actionId);
    if (!action) {
      throw new CoreAccessError("unknown_action", `Model action "${actionId}" is not registered`);
    }
    const locator = locatorOf(docId);

    // A read action writes nothing: no transaction is begun, committed or rolled
    // back, whether or not the document has one open, and an error is rethrown.
    if (action.kind === "read") {
      return (await action.execute(mcl, locator, params)) as TResult;
    }

    // Inside an open transaction the caller owns commit and rollback, so the
    // action stays one step of the caller's undo unit.
    if (transactions.has(docId)) {
      return (await action.execute(mcl, locator, params)) as TResult;
    }

    await history.begin(docId, action.title);
    try {
      const result = (await action.execute(mcl, locator, params)) as TResult;
      await history.commit(docId);
      return result;
    } catch (error) {
      try {
        await history.rollback(docId);
      } catch (rollbackError) {
        console.error("[core-plugin] rollback of a model action failed", rollbackError);
      }
      throw error;
    }
  }

  function track(docId: string, locator: string) {
    open.set(docId, locator);
    byLocator.set(locator, docId);
  }

  async function dropIfExists(locator: string) {
    try {
      await session.deleteDataset(locator);
    } catch {
      /* nothing there */
    }
    session.invalidate(locator);
  }

  return {
    builtin,
    session,
    mcl,
    history,

    async init() {
      if (!formatRegistered) {
        registerPersistentFormat(jsFormat);
        formatRegistered = true;
      }
      try {
        await initDataset(builtin, area);
      } catch (error) {
        if ((error as { code?: string }).code !== "dataset_already_exists") throw error;
      }
    },

    locatorOf,
    isOpen: (docId) => open.has(docId),

    onChange(docId, listener) {
      let set = listeners.get(docId);
      if (!set) listeners.set(docId, (set = new Set()));
      set.add(listener);
      return () => set!.delete(listener);
    },

    registerSchemas(pluginId, input) {
      const pkg: SchemaPackage = Array.isArray(input) ? { schemas: input } : input;
      const run = async () => {
        const names = pkg.schemas.map((s) => String(s.name));
        for (const name of names) {
          const owner = schemaOwners.get(name);
          if (owner && owner !== pluginId) {
            throw new CoreAccessError(
              "schema_clash",
              `Schema "${name}" of plugin "${pluginId}" is already registered by "${owner}"`,
            );
          }
        }
        const upgrade = await createUpgradeLocator(builtin);
        if (pkg.scalar_types?.length) {
          await runCommand(upgrade, { kind: "create", schema: "scalar_type", input: pkg.scalar_types } as AuthoredCommand);
        }
        await runCommand(upgrade, { kind: "create", schema: "schema", input: pkg.schemas } as AuthoredCommand);
        await upgradeDataset(builtin, upgrade);
        for (const name of names) schemaOwners.set(name, pluginId);
        for (const locator of open.values()) session.invalidate(locator);
      };
      const next = schemaQueue.then(run, run);
      schemaQueue = next.catch(() => undefined);
      return next;
    },

    registerModelActions(actions) {
      for (const action of actions) modelActions.set(action.id, action);
    },

    getModelActions: () => [...modelActions.values()],

    runModelAction,

    async createDocument(docId) {
      const locator = docLocator(docId);
      await dropIfExists(locator);
      await initDataset(locator, docId);
      track(docId, locator);
      return locator;
    },

    async loadDocument(docId, data) {
      const locator = docLocator(docId);
      await dropIfExists(locator);
      const dump = typeof data === "string" ? data : JSON.stringify(data);
      await restoreDataset(locator, dump, "json");
      session.invalidate(locator);
      track(docId, locator);
      notify(docId);
      return locator;
    },

    async saveDocument(docId) {
      return JSON.parse(await session.dumpDataset(locatorOf(docId), "json"));
    },

    async disposeDocument(docId) {
      const locator = open.get(docId);
      if (!locator) return;
      open.delete(docId);
      byLocator.delete(locator);
      transactions.delete(docId);
      await dropIfExists(locator);
    },
  };
}
