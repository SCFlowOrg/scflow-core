/**
 * What the entries of the package share: a dataset held in memory with the
 * sections of its project. This module does no input or output; each entry says
 * where a project comes from. The format of a project is specified in
 * `packages/core/docs/spec/project-file.md`.
 */

import { modelError } from "@scfloworg/core";
import type { Key, PersistenceInterface, TransientObject, TransientValue } from "@scfloworg/core";
import { createJsPersistenceInterface } from "@scfloworg/format-js/browser";
import { createProject, writeSingleFile, type Project, type SectionRegistry } from "@scfloworg/project-file";

/** What a format takes. */
export interface FileFormatOptions {
  /** The format prefix; `file` by default. */
  name?: string;
  /** The sections the owners of the host declare. */
  sections?: SectionRegistry;
}

/** A persistent format over project sections, wherever they are kept. */
export interface ProjectFormat extends PersistenceInterface {
  /** The project of a dataset already read, to reach its other sections. */
  project(rest: string): Project;
  /** Forgets a dataset held in memory; its next use reads its project again. */
  release(rest: string): void;
}

/** A dataset held in memory, with its project. */
export interface DatasetFile {
  project: Project;
  /** The content as last read or written, or `null` for a project not saved yet. */
  baseline: string | null;
  /** The keys stored, by schema: the persistence interface has no way to list schemas. */
  keys: Map<string, Set<Key>>;
}

const MANIFEST_SCHEMA = "module";
const DEFAULT_TYPE = "local:dataset";
const LEADING_DATASET_KEYS = ["name", "data_major_version", "data_minor_version"];
const NO_ROLES: Record<string, string> = {};

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortedDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedDeep);
  if (value === null || typeof value !== "object") return value;
  const entries = Object.entries(value).sort(([a], [b]) => compare(a, b));
  return Object.fromEntries(entries.map(([key, inner]) => [key, sortedDeep(inner)]));
}

/** The key the file gives an instance when it has no other record of it. */
function impliedKey(instance: unknown): unknown {
  const record = instance as { id?: unknown; name?: unknown };
  return record.id ?? record.name;
}

/** The content of a project, as a single file renders it. */
export function contentOf(project: Project): string {
  return writeSingleFile({ type: project.type, title: project.title, sections: project.sections, files: new Map() });
}

/** A format, with what an entry adds to it. */
export interface FormatParts {
  format: ProjectFormat;
  ensureLoaded(rest: string): Promise<void>;
  /** The dataset at `rest`, or fails with `dataset_not_found`. */
  requireFile(rest: string): DatasetFile;
  /** Makes a dataset of `project`, as if it had just been read. */
  adopt(rest: string, project: Project): Promise<void>;
  /** Puts the state of the dataset in the sections the format owns. */
  fillSections(rest: string, file: DatasetFile): Promise<void>;
}

/**
 * Builds a format with its own datasets.
 * @param read The project at `rest`, or `null` when there is none.
 */
export function createFormatParts(
  options: FileFormatOptions,
  read: (rest: string) => Promise<Project | null>,
): FormatParts {
  const name = options.name ?? "file";
  const inner = createJsPersistenceInterface(name);
  const files = new Map<string, DatasetFile>();
  const loading = new Map<string, Promise<void>>();
  const deleted = new Set<string>();

  function track(file: DatasetFile, schema: string, key: Key): void {
    let keys = file.keys.get(schema);
    if (!keys) {
      keys = new Set();
      file.keys.set(schema, keys);
    }
    keys.add(key);
  }

  async function store(file: DatasetFile, rest: string, schema: string, key: Key, instance: unknown): Promise<void> {
    track(file, schema, key);
    await inner.putInstance(rest, schema, key, instance as TransientValue, NO_ROLES);
  }

  async function adopt(rest: string, project: Project): Promise<void> {
    const data = (project.sections.get("data") ?? {}) as TransientObject;
    const { instances, other_instances: others, ...info } = data;
    const moduleEntries = Object.entries((project.sections.get("modules") ?? {}) as TransientObject);

    await inner.createDataset(rest, String(info.name ?? ""));
    // The patch clears the timestamps of the creation when the file has none.
    await inner.updateDataset(rest, {
      created_at: undefined,
      updated_at: undefined,
      ...info,
      ...(moduleEntries.length > 0
        ? { modules: moduleEntries.map(([module, entry]) => ({ module, ...(entry as TransientObject) })) }
        : {}),
    } as unknown as TransientValue);

    const file: DatasetFile = { project, baseline: contentOf(project), keys: new Map() };
    for (const [key, manifest] of Object.entries((project.sections.get("model") ?? {}) as TransientObject)) {
      await store(file, rest, MANIFEST_SCHEMA, key, manifest);
    }
    for (const [schema, list] of Object.entries((instances ?? {}) as Record<string, unknown[]>)) {
      for (const instance of list) await store(file, rest, schema, String(impliedKey(instance)), instance);
    }
    for (const [schema, byKey] of Object.entries((others ?? {}) as Record<string, TransientObject>)) {
      for (const [key, instance] of Object.entries(byKey)) await store(file, rest, schema, key, instance);
    }
    files.set(rest, file);
  }

  async function readAndAdopt(rest: string): Promise<void> {
    const project = await read(rest);
    if (project) await adopt(rest, project);
  }

  /** Reads the project at `rest` once. Reading again would discard what memory holds. */
  async function ensureLoaded(rest: string): Promise<void> {
    if (files.has(rest) || deleted.has(rest)) return;
    let load = loading.get(rest);
    if (!load) {
      load = readAndAdopt(rest).finally(() => loading.delete(rest));
      loading.set(rest, load);
    }
    await load;
  }

  function requireFile(rest: string): DatasetFile {
    const file = files.get(rest);
    if (!file) throw modelError("dataset_not_found", `no "${name}" dataset at "${rest}"`);
    return file;
  }

  async function fillSections(rest: string, file: DatasetFile): Promise<void> {
    const { modules: moduleList, ...info } = (await inner.getDataset(rest)) as TransientObject;
    const listed = (moduleList ?? []) as (TransientObject & { module: string })[];
    const project = file.project;

    const modules = Object.fromEntries(
      listed.map(({ module, ...entry }) => [module, { version: entry.version, digest: entry.digest }]),
    );
    if (listed.length > 0 || project.sections.has("modules")) project.sections.set("modules", modules);

    const manifestKeys = [...(file.keys.get(MANIFEST_SCHEMA) ?? [])];
    const inList = listed.map((entry) => entry.module).filter((key) => manifestKeys.includes(key));
    const ordered = [...inList, ...manifestKeys.filter((key) => !inList.includes(key))];
    const model: [string, unknown][] = [];
    for (const key of ordered) model.push([key, await inner.getInstance(rest, MANIFEST_SCHEMA, key, NO_ROLES)]);
    if (model.length > 0 || project.sections.has("model")) project.sections.set("model", Object.fromEntries(model));

    const instances: [string, unknown[]][] = [];
    const others: [string, [string, unknown][]][] = [];
    for (const schema of [...file.keys.keys()].sort(compare)) {
      if (schema === MANIFEST_SCHEMA) continue;
      const listedHere: unknown[] = [];
      const otherHere: [string, unknown][] = [];
      for (const key of [...(file.keys.get(schema) ?? [])].sort(compare)) {
        const instance = await inner.getInstance(rest, schema, key, NO_ROLES);
        if (impliedKey(instance) === key) listedHere.push(sortedDeep(instance));
        else otherHere.push([key, sortedDeep(instance)]);
      }
      if (listedHere.length > 0) instances.push([schema, listedHere]);
      if (otherHere.length > 0) others.push([schema, otherHere]);
    }

    const rest_of_info = Object.keys(info)
      .filter((key) => !LEADING_DATASET_KEYS.includes(key) && info[key] !== undefined)
      .filter((key) => !((key === "model_major_version" || key === "model_minor_version") && info[key] === 0))
      .sort(compare);
    project.sections.set(
      "data",
      Object.fromEntries([
        ...[...LEADING_DATASET_KEYS, ...rest_of_info].map((key) => [key, info[key]]),
        ["instances", Object.fromEntries(instances)],
        ...(others.length > 0
          ? [["other_instances", Object.fromEntries(others.map(([s, e]) => [s, Object.fromEntries(e)]))]]
          : []),
      ]),
    );
  }

  const format: ProjectFormat = {
    ...inner,
    name,
    areaOf(rest) {
      const separator = Math.max(rest.lastIndexOf("/"), rest.lastIndexOf("\\"));
      return separator === -1 ? "" : rest.slice(0, separator);
    },
    builtinRestFor(rest) {
      // Never a path: the built-in of an area is not a project on disk.
      return `${this.areaOf(rest)}#builtin`;
    },

    async datasetExists(rest) {
      await ensureLoaded(rest);
      return inner.datasetExists(rest);
    },
    async createDataset(rest, datasetName) {
      await ensureLoaded(rest);
      const created = await inner.createDataset(rest, datasetName);
      deleted.delete(rest);
      files.set(rest, {
        project: createProject({ type: DEFAULT_TYPE, title: datasetName }),
        baseline: null,
        keys: new Map(),
      });
      return created;
    },
    async getDataset(rest) {
      await ensureLoaded(rest);
      return inner.getDataset(rest);
    },
    async updateDataset(rest, patch) {
      await ensureLoaded(rest);
      return inner.updateDataset(rest, patch);
    },
    async deleteDataset(rest) {
      await ensureLoaded(rest);
      await inner.deleteDataset(rest);
      files.delete(rest);
      deleted.add(rest);
    },
    async getInstance(rest, schema, key, roles) {
      await ensureLoaded(rest);
      return inner.getInstance(rest, schema, key, roles);
    },
    async listInstances(rest, schema, roles) {
      await ensureLoaded(rest);
      return inner.listInstances(rest, schema, roles);
    },
    async putInstance(rest, schema, key, instance, roles) {
      await ensureLoaded(rest);
      await inner.putInstance(rest, schema, key, instance, roles);
      track(requireFile(rest), schema, key);
    },
    async deleteInstance(rest, schema, key) {
      await ensureLoaded(rest);
      await inner.deleteInstance(rest, schema, key);
      requireFile(rest).keys.get(schema)?.delete(key);
    },

    project(rest) {
      return requireFile(rest).project;
    },

    release(rest) {
      if (files.delete(rest)) void inner.deleteDataset(rest);
    },
  };

  return { format, ensureLoaded, requireFile, adopt, fillSections };
}
