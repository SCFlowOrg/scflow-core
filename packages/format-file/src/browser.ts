/**
 * The format of a host that keeps the file itself, such as a browser: datasets
 * are built from sections in memory and give them back. No disk, no path, and
 * nothing from Node is reached from here.
 */

import { readSingleFile, writeSingleFile, type Project } from "@scfloworg/project-file";
import { createFormatParts, type FileFormatOptions, type ProjectFormat } from "./projectFormat.js";

export type { FileFormatOptions, ProjectFormat } from "./projectFormat.js";

/** A project as a host holds it: its envelope and every section, by key. */
export interface ProjectContent {
  type: string;
  title: string;
  sections: Map<string, unknown>;
}

/** A format over sections held in memory. */
export interface SectionsFormat extends ProjectFormat {
  /**
   * Makes the dataset at `rest` from `content`, which is copied. The sections are
   * read as those of a file are: their owners migrate them, and what a file could
   * not hold fails with the `ProjectFileError` of the reader.
   */
  load(rest: string, content: ProjectContent): Promise<void>;
  /** A copy of what `save` of the `file` format would write for the dataset at `rest`. */
  content(rest: string): Promise<ProjectContent>;
}

/** Through the text of a single file, so that a value is what a save and a read make of it. */
function roundTrip(content: ProjectContent, options: FileFormatOptions): Project {
  const project: Project = { ...content, sections: new Map(content.sections), files: new Map() };
  return readSingleFile(writeSingleFile(project), { sections: options.sections });
}

/** Creates a format over sections in memory, with its own datasets. Its name is `file` by default. */
export function createSectionsFormat(options: FileFormatOptions = {}): SectionsFormat {
  const { format, requireFile, adopt, fillSections } = createFormatParts(options, async () => null);

  return {
    ...format,

    async load(rest, content) {
      await adopt(rest, roundTrip(content, options));
    },

    async content(rest) {
      const file = requireFile(rest);
      await fillSections(rest, file);
      const { type, title, sections } = roundTrip(file.project, options);
      return { type, title, sections };
    },
  };
}
