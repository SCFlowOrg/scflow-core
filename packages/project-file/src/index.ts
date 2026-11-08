/**
 * The SCFlow project file: a sectioned envelope in two shapes, with no
 * dependency, no MCL and no UI. This entry does no input or output, so it runs
 * in a browser; `@scfloworg/project-file/node` reads and writes the disk.
 *
 * The format is specified in `packages/core/docs/spec/project-file.md`.
 */

/** The value of the `format` key of every project. */
export const PROJECT_FORMAT = "scflow-project";
/** The version of the format this package reads and writes. */
export const PROJECT_FORMAT_VERSION = 1;
/** The sections of a document, which come first in that order. */
export const DOCUMENT_SECTIONS: readonly string[] = ["modules", "model", "data"];

const ENVELOPE_KEYS = ["format", "version", "type", "title"];
const ENVELOPE_FILE = "project.json";

/** The exceptions of the format, as the specification names them. */
export type ProjectFileErrorCode =
  | "not_a_project"
  | "unsupported_version"
  | "invalid_project"
  | "section_clash"
  | "unsupported_section_version"
  | "invalid_section_key"
  | "invalid_file_path";

/** Every refusal of this package. */
export class ProjectFileError extends Error {
  constructor(
    readonly code: ProjectFileErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ProjectFileError";
  }
}

/** The files of a folder project, by path relative to the folder, with `/` as separator. */
export type ProjectFiles = Map<string, Uint8Array>;

/** How an owner organizes its section as a sub-folder. Paths are relative to the sub-folder. */
export interface SectionFolder {
  read(files: ProjectFiles): unknown;
  write(value: unknown): ProjectFiles;
}

/** A section as its owner declares it. */
export interface SectionDeclaration {
  key: string;
  owner: string;
  /** The version of the section the owner writes, in the `version` key of the section. */
  version?: number;
  /** Carries a section from an older version to `version`. */
  migrate?(value: unknown, fromVersion: number): unknown;
  /** Set when the section is a sub-folder in the folder shape, rather than `<key>.json`. */
  folder?: SectionFolder;
}

/** The sections declared by the owners of one host. */
export interface SectionRegistry {
  get(key: string): SectionDeclaration | undefined;
  list(): SectionDeclaration[];
}

/** Builds a registry, and refuses two owners of one key with `section_clash`. */
export function createSectionRegistry(declarations: SectionDeclaration[]): SectionRegistry {
  const byKey = new Map<string, SectionDeclaration>();
  for (const declaration of declarations) {
    const existing = byKey.get(declaration.key);
    if (existing) {
      throw new ProjectFileError(
        "section_clash",
        `Section "${declaration.key}" is declared by both "${existing.owner}" and "${declaration.owner}"`,
      );
    }
    byKey.set(declaration.key, declaration);
  }
  return { get: (key) => byKey.get(key), list: () => [...byKey.values()] };
}

/** What was read from disk, so that what did not change keeps its bytes. */
interface ProjectOrigin {
  /** The text of a single file, with the rendering of the content it held. */
  single?: { text: string; rendered: string };
  /** The text of each JSON file of a folder, by path, with the rendering of its content. */
  folder: Map<string, { text: string; rendered: string }>;
  /** Every path the folder held that this package accounts for. */
  paths: Set<string>;
}

/** A project in memory, whichever shape it came from. */
export interface Project {
  type: string;
  title: string;
  /** Every section, by key. A `Map`, so that any key from a file is only data. */
  sections: Map<string, unknown>;
  /** The files and sub-folders of the folder shape that no reader knows. */
  files: ProjectFiles;
  /** @internal Set by the readers. */
  readonly origin?: ProjectOrigin;
  /** The shape the project was read from, if it was read. */
  readonly shape?: "single" | "folder";
}

/** A new project with no section. */
export function createProject(options: { type: string; title: string }): Project {
  return { type: options.type, title: options.title, sections: new Map(), files: new Map() };
}

/** What the readers and the writers take. */
export interface ProjectFileOptions {
  sections?: SectionRegistry;
}

/** What `writeFolder` gives. */
export interface FolderOutput {
  /** Every file of the folder, by relative path. */
  files: ProjectFiles;
  /** The paths read earlier that the project no longer holds. */
  removed: string[];
}

function renderJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function parseJson(text: string): unknown {
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as unknown;
}

function invalid(message: string): ProjectFileError {
  return new ProjectFileError("invalid_project", message);
}

function checkEnvelope(value: unknown): { type: string; title: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ProjectFileError("not_a_project", "A project is a JSON object");
  }
  const envelope = value as Record<string, unknown>;
  if (envelope.format !== PROJECT_FORMAT) {
    throw new ProjectFileError("not_a_project", `The format is not "${PROJECT_FORMAT}"`);
  }
  if (envelope.version !== PROJECT_FORMAT_VERSION) {
    throw new ProjectFileError("unsupported_version", `Unknown format version: ${String(envelope.version)}`);
  }
  if (typeof envelope.type !== "string" || typeof envelope.title !== "string") {
    throw invalid("The envelope needs a type and a title");
  }
  return { type: envelope.type, title: envelope.title };
}

function migrated(key: string, value: unknown, options: ProjectFileOptions): unknown {
  const declaration = options.sections?.get(key);
  if (declaration?.version === undefined) return value;
  const from = (value as { version?: unknown } | null)?.version;
  if (typeof from !== "number" || from === declaration.version) return value;
  if (from > declaration.version || !declaration.migrate) {
    throw new ProjectFileError(
      "unsupported_section_version",
      `Section "${key}" has version ${from}, and its owner "${declaration.owner}" writes ${declaration.version}`,
    );
  }
  return declaration.migrate(value, from);
}

function orderedKeys(sections: Map<string, unknown>): string[] {
  const first = DOCUMENT_SECTIONS.filter((key) => sections.has(key));
  const others = [...sections.keys()].filter((key) => !DOCUMENT_SECTIONS.includes(key));
  return [...first, ...others.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))];
}

function envelopeEntries(project: { type: string; title: string }): [string, unknown][] {
  return [
    ["format", PROJECT_FORMAT],
    ["version", PROJECT_FORMAT_VERSION],
    ["type", project.type],
    ["title", project.title],
  ];
}

function renderSingle(project: Pick<Project, "type" | "title" | "sections">): string {
  const sections = orderedKeys(project.sections).map((key): [string, unknown] => [key, project.sections.get(key)]);
  // fromEntries defines each key, so "__proto__" stays an ordinary key.
  return renderJson(Object.fromEntries([...envelopeEntries(project), ...sections]));
}

/** Reads the single-file shape. */
export function readSingleFile(text: string, options: ProjectFileOptions = {}): Project {
  let parsed: unknown;
  try {
    parsed = parseJson(text);
  } catch (error) {
    throw invalid(`The project is not valid JSON: ${(error as Error).message}`);
  }
  const { type, title } = checkEnvelope(parsed);
  const entries = Object.entries(parsed as Record<string, unknown>).filter(([key]) => !ENVELOPE_KEYS.includes(key));
  const sections = new Map(entries);
  const origin: ProjectOrigin = {
    single: { text, rendered: renderSingle({ type, title, sections }) },
    folder: new Map(),
    paths: new Set(),
  };
  for (const [key, value] of entries) sections.set(key, migrated(key, value, options));
  return { type, title, sections, files: new Map(), origin, shape: "single" };
}

/** Writes the single-file shape. A file that did not change keeps its bytes. */
export function writeSingleFile(project: Project): string {
  const rendered = renderSingle(project);
  const single = project.origin?.single;
  return single && single.rendered === rendered ? single.text : rendered;
}

/** Reads the folder shape from its files. */
export function readFolder(files: ProjectFiles, options: ProjectFileOptions = {}): Project {
  const decoder = new TextDecoder();
  const envelopeBytes = files.get(ENVELOPE_FILE);
  if (!envelopeBytes) throw new ProjectFileError("not_a_project", `The folder has no ${ENVELOPE_FILE}`);

  const origin: ProjectOrigin = { folder: new Map(), paths: new Set(files.keys()) };
  const envelopeText = decoder.decode(envelopeBytes);
  let parsed: unknown;
  try {
    parsed = parseJson(envelopeText);
  } catch (error) {
    throw invalid(`${ENVELOPE_FILE} is not valid JSON: ${(error as Error).message}`);
  }
  const { type, title } = checkEnvelope(parsed);
  const extra = Object.keys(parsed as object).find((key) => !ENVELOPE_KEYS.includes(key));
  if (extra !== undefined) throw invalid(`${ENVELOPE_FILE} holds "${extra}", which is not an envelope key`);
  origin.folder.set(ENVELOPE_FILE, { text: envelopeText, rendered: renderJson(parsed) });

  const sections = new Map<string, unknown>();
  const opaque: ProjectFiles = new Map();
  const subFolders = new Map<string, ProjectFiles>();

  for (const [path, bytes] of files) {
    if (path === ENVELOPE_FILE) continue;
    const slash = path.indexOf("/");
    if (slash >= 0) {
      const key = path.slice(0, slash);
      if (options.sections?.get(key)?.folder) {
        if (!subFolders.has(key)) subFolders.set(key, new Map());
        subFolders.get(key)?.set(path.slice(slash + 1), bytes);
      } else {
        opaque.set(path, bytes);
      }
      continue;
    }
    if (!path.endsWith(".json")) {
      opaque.set(path, bytes);
      continue;
    }
    const key = path.slice(0, -".json".length);
    const known = DOCUMENT_SECTIONS.includes(key) || options.sections?.get(key) !== undefined;
    const fileText = decoder.decode(bytes);
    let value: unknown;
    try {
      value = parseJson(fileText);
    } catch (error) {
      if (known) throw invalid(`${path} is not valid JSON: ${(error as Error).message}`);
      opaque.set(path, bytes);
      continue;
    }
    origin.folder.set(path, { text: fileText, rendered: renderJson(value) });
    sections.set(key, migrated(key, value, options));
  }

  for (const [key, subFiles] of subFolders) {
    const declaration = options.sections?.get(key);
    const value = declaration?.folder?.read(subFiles);
    sections.set(key, migrated(key, value, options));
  }

  return { type, title, sections, files: opaque, origin, shape: "folder" };
}

const FORBIDDEN_IN_A_NAME = /[\\/:*?"<>|\u0000-\u001f]/;

function checkSectionKey(key: string): void {
  if (key === "" || key === "." || key === ".." || key === "project" || FORBIDDEN_IN_A_NAME.test(key)) {
    throw new ProjectFileError("invalid_section_key", `Section key "${key}" cannot be written in a folder`);
  }
}

function checkRelativePath(path: string): void {
  const segments = path.split("/");
  const leaves = segments.some(
    (segment) => segment === "" || segment === "." || segment === ".." || FORBIDDEN_IN_A_NAME.test(segment),
  );
  if (leaves) throw new ProjectFileError("invalid_file_path", `"${path}" is not a path inside the folder`);
}

/**
 * Gives the files of the folder shape. Each JSON file that did not change keeps
 * its bytes, and `removed` lists what was read and is gone.
 */
export function writeFolder(project: Project, options: ProjectFileOptions = {}): FolderOutput {
  const encoder = new TextEncoder();
  const output: ProjectFiles = new Map();
  const origin = project.origin;

  const putJson = (path: string, value: unknown): void => {
    const rendered = renderJson(value);
    const read = origin?.folder.get(path);
    output.set(path, encoder.encode(read && read.rendered === rendered ? read.text : rendered));
  };

  for (const [path, bytes] of project.files) {
    checkRelativePath(path);
    output.set(path, bytes);
  }

  putJson(ENVELOPE_FILE, Object.fromEntries(envelopeEntries(project)));

  for (const key of orderedKeys(project.sections)) {
    checkSectionKey(key);
    const value = project.sections.get(key);
    const folder = options.sections?.get(key)?.folder;
    if (!folder) {
      putJson(`${key}.json`, value);
      continue;
    }
    for (const [relative, bytes] of folder.write(value)) {
      const path = `${key}/${relative}`;
      checkRelativePath(path);
      output.set(path, bytes);
    }
  }

  const removed = [...(origin?.paths ?? [])].filter((path) => !output.has(path)).sort();
  return { files: output, removed };
}
