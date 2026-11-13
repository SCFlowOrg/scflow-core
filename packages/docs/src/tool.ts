import type { DocsCatalogue, SearchHit, TopicFilter } from "./catalogue.js";
import { docsError } from "./errors.js";
import type { Topic } from "./topic.js";

/** The name of the tool that reads documentation. */
export const DOCS_TOOL = "read_docs";

/**
 * The definition of the read tool, shaped as an `AiToolSpec`-like MCP tool
 * definition. The package defines it and its result; a host hands it to an AI.
 */
export interface DocsToolSpec {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  /** The parameters, a JSON Schema object: `query` to search, or `topicId` to read. */
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly annotations: { readonly title: string; readonly readOnlyHint: true };
}

/** What the tool says of a topic: never its body. */
export interface DocsTopicInfo {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly kind: Topic["kind"];
  readonly audience: Topic["audience"];
}

/** The result of a call with `query`. */
export interface DocsSearchResult {
  readonly results: readonly (DocsTopicInfo & { readonly snippet: string })[];
}

/** The result of a call with `topicId`. */
export interface DocsReadResult {
  readonly topic: DocsTopicInfo;
  /** The Markdown body. */
  readonly content: string;
}

export type DocsToolResult = DocsSearchResult | DocsReadResult;

/** The read tool for one reader: its definition and its call. */
export interface DocsTool {
  readonly spec: DocsToolSpec;
  /** Searches (`{query}`) or reads (`{topicId}`); exactly one. Fails with `invalid_parameters` or `not_found`. */
  call(input: unknown): Promise<DocsToolResult>;
}

/** What `createDocsTool` takes: the filter of the reader. The tool never reaches a topic outside it. */
export type DocsToolOptions = TopicFilter & { readonly limit?: number };

const info = (topic: Topic): DocsTopicInfo => ({
  id: topic.id,
  title: topic.title,
  summary: topic.summary,
  kind: topic.kind,
  audience: topic.audience,
});

/**
 * Builds the read tool over `catalogue` for a reader that gives its audiences
 * and locale. A topic outside the audiences is neither found nor readable. The
 * description names how many topics are offered, and nothing else about them.
 * Returns `null` when the catalogue offers no topic: the reader then needs no
 * tool.
 */
export function createDocsTool(catalogue: DocsCatalogue, options: DocsToolOptions = {}): DocsTool | null {
  const filter: TopicFilter = {
    ...(options.audience === undefined ? {} : { audience: options.audience }),
    ...(options.locale === undefined ? {} : { locale: options.locale }),
  };
  const count = catalogue.topics(filter).length;
  if (count === 0) return null;
  return {
    spec: {
      name: DOCS_TOOL,
      title: "Read the documentation",
      description: [
        `Searches and reads the documentation topics of this application (${count} topics).`,
        "Call it with `query` to find topics by keyword, which returns their ids, titles and summaries,",
        "then with `topicId` to read one. Topics link to each other as [[id]].",
      ].join(" "),
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "keywords to search in the titles, summaries and bodies" },
          topicId: { type: "string", description: "the id of the topic to read, such as scflow/undo" },
        },
        additionalProperties: false,
      },
      annotations: { title: "Read the documentation", readOnlyHint: true },
    },
    async call(input) {
      const { query, topicId } = (input ?? {}) as { query?: unknown; topicId?: unknown };
      if ((query === undefined) === (topicId === undefined))
        throw docsError("invalid_parameters", "give either `query` or `topicId`, not both and not neither");
      if (query !== undefined) {
        if (typeof query !== "string" || query.trim() === "") throw docsError("invalid_parameters", "`query` must be a non-empty string");
        const hits: SearchHit[] = await catalogue.search(query, { ...filter, ...(options.limit === undefined ? {} : { limit: options.limit }) });
        return { results: hits.map((hit) => ({ ...info(hit.topic), snippet: hit.snippet })) };
      }
      if (typeof topicId !== "string" || topicId === "") throw docsError("invalid_parameters", "`topicId` must be a non-empty string");
      const topic = catalogue.topics(filter).find((candidate) => candidate.id === topicId);
      if (!topic) throw docsError("not_found", `no documentation topic "${topicId}" here`);
      return { topic: info(topic), content: await catalogue.read(topicId, filter.locale) };
    },
  };
}
