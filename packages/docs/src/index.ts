/**
 * `@scfloworg/docs`: the neutral documentation package. Topics with front
 * matter, the source contract, the catalogue merged from sources, the manifest
 * and the contract of the read tool (see `docs/docs.md`). It knows no module,
 * plugin or user interface.
 */
export { AUDIENCES, DEFAULT_LOCALE, TOPIC_KINDS, isTopicId, topicLinks, validateTopic } from "./topic.js";
export type { Audience, Topic, TopicKind } from "./topic.js";
export { parseFrontMatterBlock, parseTopic, splitFrontMatter } from "./frontMatter.js";
export type { ParsedTopic } from "./frontMatter.js";
export { createCatalogue } from "./catalogue.js";
export type {
  CatalogueOptions,
  CheckOptions,
  DocsCatalogue,
  DocsProblem,
  DocsSource,
  SearchHit,
  SearchOptions,
  TopicFilter,
} from "./catalogue.js";
export { createMemorySource } from "./sources.js";
export { DOCS_MANIFEST_FILE, buildManifest, parseManifest, serializeManifest } from "./manifest.js";
export type { DocsManifest } from "./manifest.js";
export { DOCS_TOOL, createDocsTool } from "./tool.js";
export type {
  DocsReadResult,
  DocsSearchResult,
  DocsTool,
  DocsToolOptions,
  DocsToolResult,
  DocsToolSpec,
  DocsTopicInfo,
} from "./tool.js";
export { DocsError, DocsErrorCode, docsError } from "./errors.js";
export type { DocsErrorCodeName } from "./errors.js";
