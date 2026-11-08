/**
 * The `file` persistent format: a dataset stored in a project file.
 *
 * A dataset is read on its first use and held in memory. The disk is written
 * only by `save`, so a transaction or an undo never touches it. The format of
 * the file is specified in `packages/core/docs/spec/project-file.md`.
 */

import type { Project } from "@scfloworg/project-file";
import { readProject, writeProject, type WriteProjectResult } from "@scfloworg/project-file/node";
import { contentOf, createFormatParts, type FileFormatOptions, type ProjectFormat } from "./projectFormat.js";

export type { FileFormatOptions, ProjectFormat } from "./projectFormat.js";

/** The refusal of `save` when another tool changed the project since it was read. */
export class FileFormatError extends Error {
  readonly code = "project_changed_on_disk";
  constructor(message: string) {
    super(message);
    this.name = "FileFormatError";
  }
}

/** The `file` format: a persistent format, with what a host needs to save. */
export interface FileFormat extends ProjectFormat {
  /**
   * Writes the dataset to its project, with every other section kept. Nothing is
   * written when nothing changed.
   * @throws `project_changed_on_disk` when the content on disk is not what was read.
   */
  save(rest: string, options?: { shape?: "single" | "folder" }): Promise<WriteProjectResult>;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

/** Creates a `file` format with its own datasets. */
export function createFileFormat(options: FileFormatOptions = {}): FileFormat {
  const sections = options.sections;

  async function readIfPresent(rest: string): Promise<Project | null> {
    try {
      return await readProject(rest, { sections });
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  const { format, ensureLoaded, requireFile, fillSections } = createFormatParts(options, readIfPresent);

  return {
    ...format,

    async save(rest, saveOptions = {}) {
      await ensureLoaded(rest);
      const file = requireFile(rest);

      const onDisk = await readIfPresent(rest);
      const unchanged =
        file.baseline === null ? onDisk === null : onDisk !== null && contentOf(onDisk) === file.baseline;
      if (!unchanged) throw new FileFormatError(`The project at "${rest}" changed on disk since it was read`);

      // Unknown files and the formatting of a file belong to whoever wrote them:
      // the disk holds their last state, and the same content keeps those bytes.
      if (onDisk) file.project = { ...file.project, files: onDisk.files, origin: onDisk.origin };
      await fillSections(rest, file);

      const shape =
        saveOptions.shape ?? file.project.shape ?? (rest.toLowerCase().endsWith(".json") ? "single" : "folder");
      const result = await writeProject(rest, file.project, { shape, sections });

      // What is on disk now is the new origin of every byte.
      file.project = await readProject(rest, { sections });
      file.baseline = contentOf(file.project);
      return result;
    },
  };
}

/** The default format, under the export name `--format-module` loaders read. */
export const format = createFileFormat();
