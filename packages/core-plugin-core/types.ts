/**
 * Public contract of `core-plugin`, as business plugins see it through
 * `ctx.useApi("core-plugin")`. Type-only: importing it adds nothing to a bundle.
 */
import type { MclAccess, ModelActionDefinition } from "@scfloworg/core";

export type MaybePromise<T> = T | Promise<T>;

/** Schemas (and optional scalar types) a plugin adds to the shared built-in. */
export interface SchemaPackage {
  scalar_types?: Record<string, unknown>[];
  schemas: Record<string, unknown>[];
}

/** A kind of document owned by a business plugin, stored as one MCL dataset. */
export interface CoreDocumentType {
  id: string;
  /** i18n key (already namespaced) or plain text, shown in "New". */
  title: string;
  extensions?: string[];
  defaultExtension?: () => string;
  defaultViews?: string[];
  /** Seed a brand new document. Runs right after its dataset is created. */
  onCreate?: (docId: string, mcl: MclAccess, locator: string) => MaybePromise<void>;
}

export interface CorePluginApi {
  /** Filtered access: open documents only, plus read-only queries on the built-in. */
  mcl: MclAccess;
  /** Locator of an open document's dataset. Throws when the document is not open. */
  locatorOf(docId: string): string;
  /** True when the document is an open core document. */
  isOpen(docId: string): boolean;
  /** Called after a committed change (or reload) of a document; `null` = any document. */
  onChange(docId: string | null, listener: (docId: string) => void): () => void;
  /** Add a plugin's schemas to the shared built-in. Call during `setup`. */
  registerSchemas(pluginId: string, schemas: SchemaPackage | Record<string, unknown>[]): Promise<void>;
  /** Register a document type with `documents`, backed by one dataset per document. */
  registerDocumentType(type: CoreDocumentType): () => void;
  /** Register model actions that UIs and AI assistants can run on open documents. */
  registerModelActions(actions: ModelActionDefinition[]): void;
  /** The registered model actions. */
  getModelActions(): readonly ModelActionDefinition[];
  /**
   * Run a registered action on an open document. Inside an open document
   * transaction the action joins it; otherwise it runs in a transaction of its own.
   * An action declared `kind: "read"` runs outside any transaction.
   * Throws `unknown_action` or `document_not_open`.
   */
  runModelAction<TResult = unknown>(
    docId: string,
    actionId: string,
    params: Record<string, unknown>,
  ): Promise<TResult>;
}
