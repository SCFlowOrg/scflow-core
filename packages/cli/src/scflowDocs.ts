/**
 * `scflow docs`: the documentation topics of the installed modules, without a
 * project (see `docs/scflow.md`, Documentation). The catalogue is the one of
 * `@scfloworg/environment` over `env.docs`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  DOCS_AUDIENCES,
  DOCS_MANIFEST_FILE,
  buildDocsManifest,
  createDocsCatalogue,
  serializeDocsManifest,
  type DocsAudience,
  type DocsCatalogue,
  type DocsProblem,
  type DocsSource,
} from "@scfloworg/environment";

/** The subcommands of `scflow docs`. */
export const DOCS_COMMANDS = ["list", "check", "build", "show"] as const;

/** What `runDocs` needs of the command line. */
export interface DocsRequest {
  command: (typeof DOCS_COMMANDS)[number];
  /** The `<id>` of `show`, the directory of `build`. */
  argument: string | undefined;
  audiences: string[];
  locale: string | undefined;
}

/** A wrong command line, which the caller shows with the usage. */
export class DocsUsageError extends Error {}

/** What `runDocs` reports: lines to print, and the exit code. */
export interface DocsOutcome {
  out: unknown[];
  err: string[];
  code: number;
}

function audiencesOf(values: string[]): DocsAudience[] | undefined {
  for (const value of values) {
    if (!(DOCS_AUDIENCES as readonly string[]).includes(value))
      throw new DocsUsageError(`--audience must be one of ${DOCS_AUDIENCES.join(", ")}, not "${value}"`);
  }
  return values.length === 0 ? undefined : (values as DocsAudience[]);
}

const problemOwner = (problem: DocsProblem): string => ("id" in problem ? problem.id : "key" in problem ? `help key ${problem.key}` : "?");

/** Runs one `scflow docs` subcommand over the source of the installed modules. */
export async function runDocs(source: DocsSource, request: DocsRequest): Promise<DocsOutcome> {
  const catalogue: DocsCatalogue = await createDocsCatalogue([source]);
  const audience = audiencesOf(request.audiences);
  const filter = {
    ...(audience === undefined ? {} : { audience }),
    ...(request.locale === undefined ? {} : { locale: request.locale }),
  };

  switch (request.command) {
    case "list":
      return {
        out: [
          catalogue.topics(filter).map(({ id, title, summary, kind, audience: who, locale }) => ({ id, title, summary, kind, audience: who, locale })),
        ],
        err: [],
        code: 0,
      };
    case "check": {
      const problems = await catalogue.check();
      return {
        out: [{ ok: problems.length === 0, topics: catalogue.all().length, problems }],
        err: problems.map((problem) => `${problemOwner(problem)}: ${problem.message}`),
        code: problems.length === 0 ? 0 : 1,
      };
    }
    case "show": {
      if (request.argument === undefined) throw new DocsUsageError("docs show needs a topic id");
      const topic = catalogue.topics(filter).find((candidate) => candidate.id === request.argument);
      if (!topic) throw Object.assign(new Error(`no documentation topic "${request.argument}" here`), { code: "not_found" });
      return { out: [{ topic, content: await catalogue.read(topic.id, request.locale) }], err: [], code: 0 };
    }
    case "build": {
      if (request.argument === undefined) throw new DocsUsageError("docs build needs a directory");
      const dir = resolve(request.argument);
      const entries = catalogue.all().filter((topic) => audience === undefined || audience.includes(topic.audience));
      const written: string[] = [];
      for (const topic of entries) {
        const file = join(dir, topic.locale, `${topic.id}.md`);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, await catalogue.read(topic.id, topic.locale));
        written.push(file);
      }
      mkdirSync(dir, { recursive: true });
      const manifest = join(dir, DOCS_MANIFEST_FILE);
      writeFileSync(manifest, serializeDocsManifest(buildDocsManifest(entries, source.id)));
      return { out: [{ topics: entries.length, manifest, written }], err: [], code: 0 };
    }
  }
}
