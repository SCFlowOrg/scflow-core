import { docsError } from "./errors.js";
import { validateTopic, type Topic } from "./topic.js";

/** The file name of a manifest. */
export const DOCS_MANIFEST_FILE = "docs-manifest.json";

/** The manifest of a source or a catalogue: the metadata of its topics, never their bodies. */
export interface DocsManifest {
  readonly version: 1;
  /** The id of the source that wrote it, when one did. */
  readonly source?: string;
  readonly topics: readonly Topic[];
}

/** Builds a manifest, its topics ordered by id then locale. */
export function buildManifest(topics: readonly Topic[], source?: string): DocsManifest {
  const ordered = [...topics].sort((a, b) => a.id.localeCompare(b.id) || a.locale.localeCompare(b.locale));
  return { version: 1, ...(source === undefined ? {} : { source }), topics: ordered };
}

/** The text of a manifest, JSON indented by two spaces with a final newline: stable, so a build diff shows only real changes. */
export function serializeManifest(manifest: DocsManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/** Reads the text of a manifest and validates every topic. Fails with `invalid_topic`. */
export function parseManifest(text: string): DocsManifest {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw docsError("invalid_topic", `${DOCS_MANIFEST_FILE} is not valid JSON`);
  }
  const raw = data as { version?: unknown; source?: unknown; topics?: unknown } | null;
  if (!raw || raw.version !== 1 || !Array.isArray(raw.topics))
    throw docsError("invalid_topic", `${DOCS_MANIFEST_FILE} must be an object with "version": 1 and a list of "topics"`);
  const topics = raw.topics.map((topic, i) => validateTopic(topic, `${DOCS_MANIFEST_FILE} topic ${i}`));
  return buildManifest(topics, typeof raw.source === "string" ? raw.source : undefined);
}
