/**
 * The workspace of a host that keeps the file itself, such as a browser:
 * documents are built from sections in memory and give them back, with no disk
 * and no path. Nothing from Node is reached from here.
 */

import type { Environment } from "@scfloworg/environment/browser";
import type { ProjectContent, SectionsFormat } from "@scfloworg/format-file/browser";
import {
  createDocument,
  datasetNameOf,
  openDocument,
  requireFormat,
  WorkspaceError,
  type BaseDocument,
  type DocumentGuards,
  type DocumentHost,
  type NewDocumentOptions,
} from "./document.js";

export { WorkspaceError } from "./document.js";
export type { BaseDocument, DocumentTransaction, WorkspaceErrorCode } from "./document.js";
export type { ProjectContent } from "@scfloworg/format-file/browser";

/** An open document whose sections are in memory. */
export interface SectionsDocument extends BaseDocument {
  /** The name the host gives the document in this workspace. */
  readonly id: string;
  /**
   * A copy of the sections of the document, equal to what a save on disk would
   * write. Allowed on a read-only document, since it writes nothing.
   * @throws `transaction_open` during a transaction.
   */
  content(): Promise<ProjectContent>;
}

/** What `workspace.create` takes. */
export interface CreateSectionsDocumentOptions extends NewDocumentOptions {
  id: string;
  /** The name of the dataset, an identifier; derived from the id by default. */
  name?: string;
}

/** The documents of a host, on sections in memory. */
export interface SectionsWorkspace {
  create(options: CreateSectionsDocumentOptions): Promise<SectionsDocument>;
  /**
   * Opens a document on `content`, which is copied.
   * @throws `document_open` when `id` is already open.
   */
  open(id: string, content: ProjectContent, options?: { readOnly?: boolean }): Promise<SectionsDocument>;
  get(id: string): SectionsDocument | undefined;
  list(): SectionsDocument[];
}

/** What `createSectionsWorkspace` takes. */
export interface SectionsWorkspaceOptions {
  environment: Environment;
  /** The format that holds the sections, one of the formats of `environment`. */
  file: SectionsFormat;
}

/** Creates a workspace on sections in memory. Fails with `unknown_format` when `file` is not a format of `environment`. */
export function createSectionsWorkspace(options: SectionsWorkspaceOptions): SectionsWorkspace {
  const { environment, file } = options;
  requireFormat(environment, file);
  const documents = new Map<string, SectionsDocument>();
  const opening = new Set<string>();
  const host: DocumentHost<SectionsDocument> = { environment, file, documents };

  const extrasOf = (id: string) => (guards: DocumentGuards) => ({
    id,
    async content() {
      guards.refuseIfOpen("reading the content");
      return file.content(id);
    },
  });

  return {
    async create({ id, name, ...rest }) {
      return createDocument(host, id, { ...rest, name: name ?? datasetNameOf(id) }, extrasOf(id));
    },
    async open(id, content, openOptions = {}) {
      if (documents.has(id) || opening.has(id)) {
        throw new WorkspaceError("document_open", `The document "${id}" is already open`);
      }
      opening.add(id);
      try {
        await file.load(id, content);
        return await openDocument(host, id, openOptions.readOnly === true, extrasOf(id));
      } catch (error) {
        file.release(id);
        throw error;
      } finally {
        opening.delete(id);
      }
    },
    get: (id) => documents.get(id),
    list: () => [...documents.values()],
  };
}
