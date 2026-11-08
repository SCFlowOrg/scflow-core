/**
 * The workspace: documents, their sections, transactions and undo, over an
 * environment and the `file` format, with no UI (see `docs/workspace.md`).
 * This entry works on disk paths; `@scfloworg/workspace/browser` on sections in
 * memory.
 */

import type { Environment } from "@scfloworg/environment";
import type { FileFormat } from "@scfloworg/format-file";
import type { WriteProjectResult } from "@scfloworg/project-file/node";
import { basename, resolve } from "node:path";
import {
  createDocument,
  datasetNameOf,
  openDocument,
  requireFormat,
  type BaseDocument,
  type DocumentGuards,
  type DocumentHost,
  type NewDocumentOptions,
} from "./document.js";

export { WorkspaceError } from "./document.js";
export type { BaseDocument, DocumentTransaction, WorkspaceErrorCode } from "./document.js";

/** An open document. */
export interface Document extends BaseDocument {
  /** The absolute path of the project. */
  readonly path: string;
  save(): Promise<WriteProjectResult>;
}

/** What `workspace.create` takes. */
export interface CreateDocumentOptions extends NewDocumentOptions {
  path: string;
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

/** Creates a workspace. Fails with `unknown_format` when `file` is not a format of `environment`. */
export function createWorkspace(options: WorkspaceOptions): Workspace {
  const { environment, file } = options;
  requireFormat(environment, file);
  const documents = new Map<string, Document>();
  const opening = new Map<string, Promise<Document>>();
  const host: DocumentHost<Document> = { environment, file, documents };

  const extrasAt = (path: string) => (guards: DocumentGuards) => ({
    path,
    async save() {
      guards.refuseIfReadOnly("save");
      guards.refuseIfOpen("save");
      return file.save(path);
    },
  });

  return {
    async create({ path: given, name, ...rest }) {
      const path = resolve(given);
      return createDocument(host, path, { ...rest, name: name ?? datasetNameOf(basename(path, ".json")) }, extrasAt(path));
    },
    open(given, openOptions = {}) {
      const path = resolve(given);
      const known = documents.get(path);
      if (known) return Promise.resolve(known);
      let pending = opening.get(path);
      if (!pending) {
        pending = openDocument(host, path, openOptions.readOnly === true, extrasAt(path)).finally(() =>
          opening.delete(path),
        );
        opening.set(path, pending);
      }
      return pending;
    },
    get: (path) => documents.get(resolve(path)),
    list: () => [...documents.values()],
  };
}
