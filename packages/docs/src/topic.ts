import { docsError } from "./errors.js";

/** The kinds of topic, after the four kinds of documentation. */
export const TOPIC_KINDS = ["tutorial", "how-to", "reference", "explanation"] as const;
export type TopicKind = (typeof TOPIC_KINDS)[number];

/** The audiences of a topic: who reads it. The caller asks for the ones it wants. */
export const AUDIENCES = ["user", "plugin-dev", "model-dev"] as const;
export type Audience = (typeof AUDIENCES)[number];

/** The locale a topic is written in when it says nothing, and the fallback of every lookup. */
export const DEFAULT_LOCALE = "en";

/** The metadata of a topic: the front matter of its file, never its body. */
export interface Topic {
  /** The namespace of the owner, a slash and a name; stable, never reused. */
  readonly id: string;
  readonly title: string;
  /** One or two sentences; also the search text. */
  readonly summary: string;
  readonly kind: TopicKind;
  readonly audience: Audience;
  /** One file per locale. */
  readonly locale: string;
  /** The help keys that open this topic from an interface. */
  readonly context: readonly string[];
  /** What the topic describes, as opaque values: the source that owns the topic checks them. */
  readonly uses: readonly string[];
  /** `true` for reference built from declarations. */
  readonly generated: boolean;
}

const TOPIC_ID = /^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/;
const LOCALE = /^[a-z]{2,3}(-[A-Za-z0-9]+)*$/;

/** Whether `id` is a topic id: `namespace/name`, the name possibly with more `/` segments. */
export function isTopicId(id: unknown): id is string {
  return typeof id === "string" && TOPIC_ID.test(id);
}

function strings(value: unknown, field: string, where: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item === ""))
    throw docsError("invalid_topic", `${where}: "${field}" must be a list of non-empty strings`);
  return [...new Set(value as string[])];
}

function text(value: unknown, field: string, where: string): string {
  if (typeof value !== "string" || value.trim() === "") throw docsError("invalid_topic", `${where}: "${field}" is required`);
  return value.trim();
}

/**
 * Checks a plain object as a topic and returns it normalized: `locale` defaults
 * to `DEFAULT_LOCALE`, `context` and `uses` to empty, `generated` to `false`.
 * Fails with `invalid_topic`, naming `where` when it is given.
 */
export function validateTopic(value: unknown, where = "topic"): Topic {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw docsError("invalid_topic", `${where}: a topic is a mapping`);
  const raw = value as Record<string, unknown>;
  const id = raw.id;
  if (!isTopicId(id)) throw docsError("invalid_topic", `${where}: "id" must be "namespace/name", got ${JSON.stringify(id)}`);
  const here = `${where} "${id}"`;
  const kind = raw.kind;
  if (!(TOPIC_KINDS as readonly unknown[]).includes(kind))
    throw docsError("invalid_topic", `${here}: "kind" must be one of ${TOPIC_KINDS.join(", ")}`);
  const audience = raw.audience;
  if (!(AUDIENCES as readonly unknown[]).includes(audience))
    throw docsError("invalid_topic", `${here}: "audience" must be one of ${AUDIENCES.join(", ")}`);
  const locale = raw.locale === undefined ? DEFAULT_LOCALE : raw.locale;
  if (typeof locale !== "string" || !LOCALE.test(locale))
    throw docsError("invalid_topic", `${here}: "locale" must be a language tag such as "en" or "fr-CA"`);
  if (raw.generated !== undefined && typeof raw.generated !== "boolean")
    throw docsError("invalid_topic", `${here}: "generated" must be true or false`);
  return Object.freeze({
    id,
    title: text(raw.title, "title", here),
    summary: text(raw.summary, "summary", here),
    kind: kind as TopicKind,
    audience: audience as Audience,
    locale,
    context: Object.freeze(strings(raw.context, "context", here)),
    uses: Object.freeze(strings(raw.uses, "uses", here)),
    generated: raw.generated === true,
  });
}

const LINK = /\[\[([^\]\n]+)\]\]/g;

/**
 * The topic ids a Markdown body links to with `[[id]]` (or `[[id|label]]`):
 * once each, in order, ignoring code spans and fenced code.
 */
export function topicLinks(body: string): string[] {
  const prose = body.replace(/^(```|~~~)[\s\S]*?^\1[^\n]*$/gm, "").replace(/`[^`\n]*`/g, "");
  const links = new Set<string>();
  for (const match of prose.matchAll(LINK)) links.add(match[1].split("|")[0].trim());
  return [...links];
}
