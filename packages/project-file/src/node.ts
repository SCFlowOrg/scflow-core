/**
 * Reads and writes a project on disk, in either shape. The main entry of the
 * package holds the format and does no input or output.
 */

import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  readFolder,
  readSingleFile,
  writeFolder,
  writeSingleFile,
  type Project,
  type ProjectFileOptions,
  type ProjectFiles,
} from "./index.js";

/** Folders never read as part of a project: they are left alone on disk. */
const SKIPPED_FOLDERS = new Set([".git", "node_modules"]);

async function collect(root: string, prefix: string, into: ProjectFiles): Promise<void> {
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!SKIPPED_FOLDERS.has(entry.name)) await collect(root, path, into);
    } else if (entry.isFile()) {
      into.set(path, await readFile(join(root, path)));
    }
  }
}

async function isFolder(path: string): Promise<boolean | undefined> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Reads the project at `path`: a folder, or a single file. */
export async function readProject(path: string, options: ProjectFileOptions = {}): Promise<Project> {
  if (await isFolder(path)) {
    const files: ProjectFiles = new Map();
    await collect(path, "", files);
    return readFolder(files, options);
  }
  return readSingleFile(await readFile(path, "utf8"), options);
}

/** What `writeProject` takes. */
export interface WriteProjectOptions extends ProjectFileOptions {
  /** The shape to write. By default, a folder if `path` is one, or else the shape the project was read from. */
  shape?: "single" | "folder";
}

/** The paths `writeProject` changed, relative to a folder, or `path` itself for a single file. */
export interface WriteProjectResult {
  written: string[];
  removed: string[];
}

/** Writes a file through a temporary one, unless it already holds these bytes. */
async function writeIfChanged(path: string, bytes: Uint8Array): Promise<boolean> {
  try {
    if (Buffer.compare(await readFile(path), bytes) === 0) return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, bytes);
  await rename(temporary, path);
  return true;
}

/** Writes a project at `path`. A file that already holds the right bytes is not touched. */
export async function writeProject(
  path: string,
  project: Project,
  options: WriteProjectOptions = {},
): Promise<WriteProjectResult> {
  const folder = await isFolder(path);
  const shape = options.shape ?? (folder ? "folder" : (project.shape ?? "single"));

  if (shape === "single") {
    const changed = await writeIfChanged(path, new TextEncoder().encode(writeSingleFile(project)));
    return { written: changed ? [path] : [], removed: [] };
  }

  const output = writeFolder(project, options);
  const written: string[] = [];
  for (const [relative, bytes] of output.files) {
    if (await writeIfChanged(join(path, relative), bytes)) written.push(relative);
  }
  for (const relative of output.removed) await rm(join(path, relative), { force: true });
  return { written: written.sort(), removed: output.removed };
}
