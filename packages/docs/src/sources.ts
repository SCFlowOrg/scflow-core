import type { DocsSource } from "./catalogue.js";
import { docsError } from "./errors.js";
import { parseTopic } from "./frontMatter.js";
import type { Topic } from "./topic.js";

/**
 * A source over topic files held in memory: each string is a Markdown file
 * with front matter. For a fixture catalogue, a test, or a host that has read
 * its files already. Fails with `invalid_topic` for a file that does not parse.
 */
export function createMemorySource(id: string, files: readonly string[]): DocsSource {
  const parsed = files.map((file, index) => parseTopic(file, `${id} file ${index + 1}`));
  const at = (topicId: string, locale: string) => parsed.find(({ topic }) => topic.id === topicId && topic.locale === locale);
  return {
    id,
    async list(): Promise<Topic[]> {
      return parsed.map(({ topic }) => topic);
    },
    async read(topicId, locale = "en") {
      const found = at(topicId, locale);
      if (!found) throw docsError("not_found", `source "${id}" has no topic "${topicId}" in "${locale}"`);
      return found.body;
    },
  };
}
