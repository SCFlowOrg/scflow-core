/**
 * The documentation of an environment: the topics of its installed modules as a
 * source of `@scfloworg/docs` (see `docs/environment.md`, Documentation, and
 * Topic in `packages/core/docs/spec/meta-model.md`).
 */
import { DEFAULT_LOCALE, docsError, validateTopic, type DocsSource, type Topic } from "@scfloworg/docs";
import type { ModuleCatalogue } from "./catalogue.js";

/** The id of the source `env.docs`. */
export const MODULE_DOCS_SOURCE = "modules";

/**
 * The documentation source of the installed modules: one topic per entry of
 * `docs` of a manifest, in the order of the modules, then of their manifests.
 * It reads the catalogue at each call, so a module installed later gives its
 * topics once the catalogue of `@scfloworg/docs` refreshes. A module that comes
 * only embedded in a dataset is not installed and gives none, as for skills.
 */
export function createModuleDocsSource(modules: ModuleCatalogue): DocsSource {
  return {
    id: MODULE_DOCS_SOURCE,
    async list(): Promise<Topic[]> {
      return modules.list().flatMap((installed) =>
        (installed.manifest.docs ?? []).map((entry) => {
          const { file: _file, ...topic } = entry;
          return validateTopic(topic, `module "${installed.key}" topic`);
        }),
      );
    },
    async read(topicId, locale = DEFAULT_LOCALE) {
      for (const installed of modules.list()) {
        const entry = (installed.manifest.docs ?? []).find((topic) => topic.id === topicId && topic.locale === locale);
        const loader = entry && installed.docs.get(entry.file);
        if (loader) return loader();
      }
      throw docsError("not_found", `no installed module offers the topic "${topicId}" in "${locale}"`);
    },
  };
}
