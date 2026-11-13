import { docsError } from "./errors.js";
import { DEFAULT_LOCALE, topicLinks, type Audience, type Topic } from "./topic.js";

/**
 * Whatever owns documentation: an MCL module, a framework, a plugin. It lists
 * its topics, one entry per topic and locale, and reads their bodies.
 */
export interface DocsSource {
  /** Names the source in problems and results. */
  readonly id: string;
  list(): Promise<Topic[]>;
  /** The Markdown body, without front matter, of the topic in `locale` (the default locale when omitted). Fails when the source has none. */
  read(topicId: string, locale?: string): Promise<string>;
}

/** What narrows a lookup. The caller gives it; the package never decides an audience. */
export interface TopicFilter {
  /** One audience or several; omitted, every audience. */
  readonly audience?: Audience | readonly Audience[];
  /** The preferred locale; a topic without it comes in the default locale. */
  readonly locale?: string;
}

export interface CatalogueOptions {
  /** The fallback locale, `en` by default. */
  readonly defaultLocale?: string;
}

/** One hit of `search`. */
export interface SearchHit {
  readonly topic: Topic;
  readonly score: number;
  /** A short extract of the body around the first match, or the summary. */
  readonly snippet: string;
}

export interface SearchOptions extends TopicFilter {
  /** At most this many hits, 10 by default. */
  readonly limit?: number;
}

/** A defect `check` reports. */
export type DocsProblem =
  | { readonly code: "duplicate_id"; readonly id: string; readonly locale: string; readonly sources: readonly string[]; readonly message: string }
  | { readonly code: "unresolved_link"; readonly id: string; readonly locale: string; readonly link: string; readonly message: string }
  | { readonly code: "unresolved_help_key"; readonly key: string; readonly message: string }
  | { readonly code: "ambiguous_help_key"; readonly key: string; readonly topics: readonly string[]; readonly message: string }
  | { readonly code: "unreadable_topic"; readonly id: string; readonly locale: string; readonly source: string; readonly message: string };

export interface CheckOptions {
  /** The help keys the interface declares: each must resolve to one topic. Without it only keys that two topics claim are reported. */
  readonly helpKeys?: Iterable<string>;
}

/** The merge of the topics of several sources. */
export interface DocsCatalogue {
  /** The topics, one per id, in the locale asked or the default one, ordered by id. */
  topics(filter?: TopicFilter): Topic[];
  /** The topic `id` in `locale`, falling back to the default locale, else to any locale; `undefined` when unknown. */
  get(id: string, locale?: string): Topic | undefined;
  /** The topic whose `context` lists `key`: the first by id when several do. */
  resolveHelpKey(key: string, options?: TopicFilter): Topic | undefined;
  /** The Markdown body of the topic `id`, as `get` resolves its locale. Fails with `not_found`. */
  read(id: string, locale?: string): Promise<string>;
  /** Keyword search over titles, summaries and bodies, best first. */
  search(query: string, options?: SearchOptions): Promise<SearchHit[]>;
  /** Reports every duplicate id, unresolved `[[id]]` link and failing help key. An empty list means the catalogue is sound. */
  check(options?: CheckOptions): Promise<DocsProblem[]>;
  /** Lists the sources again, for a source that gained or lost topics. */
  refresh(): Promise<void>;
  /** Every entry, one per id and locale, ordered by id then locale: what the manifest holds. */
  all(): Topic[];
}

interface Entry {
  readonly topic: Topic;
  readonly source: DocsSource;
}

const key = (id: string, locale: string): string => `${id}\u0000${locale}`;

function audienceTest(filter: TopicFilter | undefined): (topic: Topic) => boolean {
  const wanted = filter?.audience === undefined ? undefined : new Set<string>([filter.audience].flat());
  return (topic) => wanted === undefined || wanted.has(topic.audience);
}

function tokens(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/**
 * Merges the topics of `sources`. A topic id with the same locale from two
 * sources is a duplicate: the first source keeps it, and `check` reports it.
 * Lists every source once here; call `refresh` to list them again.
 */
export async function createCatalogue(sources: readonly DocsSource[], options: CatalogueOptions = {}): Promise<DocsCatalogue> {
  const defaultLocale = options.defaultLocale ?? DEFAULT_LOCALE;
  let entries = new Map<string, Entry>();
  let duplicates: DocsProblem[] = [];
  const bodies = new Map<string, Promise<string>>();

  async function load(): Promise<void> {
    const next = new Map<string, Entry>();
    const found: DocsProblem[] = [];
    for (const source of sources) {
      for (const topic of await source.list()) {
        const at = key(topic.id, topic.locale);
        const held = next.get(at);
        if (held) {
          found.push({
            code: "duplicate_id",
            id: topic.id,
            locale: topic.locale,
            sources: [held.source.id, source.id],
            message: `topic "${topic.id}" (${topic.locale}) is given by "${held.source.id}" and by "${source.id}"`,
          });
        } else next.set(at, { topic, source });
      }
    }
    entries = next;
    duplicates = found;
    bodies.clear();
  }
  await load();

  const ids = (): string[] => [...new Set([...entries.values()].map((entry) => entry.topic.id))].sort();

  function entryOf(id: string, locale?: string): Entry | undefined {
    for (const wanted of [locale ?? defaultLocale, defaultLocale]) {
      const entry = entries.get(key(id, wanted));
      if (entry) return entry;
    }
    return [...entries.values()].filter((entry) => entry.topic.id === id).sort((a, b) => a.topic.locale.localeCompare(b.topic.locale))[0];
  }

  function body(entry: Entry): Promise<string> {
    const at = key(entry.topic.id, entry.topic.locale);
    let held = bodies.get(at);
    if (!held) {
      held = entry.source.read(entry.topic.id, entry.topic.locale);
      bodies.set(at, held);
      held.catch(() => bodies.delete(at));
    }
    return held;
  }

  function visible(filter?: TopicFilter): Entry[] {
    const allowed = audienceTest(filter);
    return ids()
      .map((id) => entryOf(id, filter?.locale))
      .filter((entry): entry is Entry => entry !== undefined && allowed(entry.topic));
  }

  return {
    topics: (filter) => visible(filter).map((entry) => entry.topic),
    get: (id, locale) => entryOf(id, locale)?.topic,
    resolveHelpKey(helpKey, filter) {
      // The help keys belong to the topic, whatever the locale: a translation need not repeat them.
      const keyed = new Set([...entries.values()].filter((entry) => entry.topic.context.includes(helpKey)).map((entry) => entry.topic.id));
      return visible(filter).find((entry) => keyed.has(entry.topic.id))?.topic;
    },
    async read(id, locale) {
      const entry = entryOf(id, locale);
      if (!entry) throw docsError("not_found", `no documentation topic "${id}"`);
      return body(entry);
    },
    async search(query, filter) {
      const terms = [...new Set(tokens(query))];
      if (terms.length === 0) return [];
      const hits: SearchHit[] = [];
      for (const entry of visible(filter)) {
        const { topic } = entry;
        const title = tokens(topic.title);
        const summary = tokens(topic.summary);
        let text = "";
        try {
          text = await body(entry);
        } catch {
          // A body that cannot be read is searched by its metadata; `check` reports it.
        }
        const words = tokens(text);
        let score = 0;
        let matched = 0;
        for (const term of terms) {
          const count = (list: string[]) => list.filter((word) => word === term).length;
          const part = (title.includes(term) ? 5 : 0) + (summary.includes(term) ? 3 : 0) + Math.min(count(words), 5);
          if (part > 0) matched += 1;
          score += part;
        }
        if (matched === 0) continue;
        score += matched === terms.length ? 5 * terms.length : 0;
        hits.push({ topic, score, snippet: snippet(text, terms) || topic.summary });
      }
      hits.sort((a, b) => b.score - a.score || a.topic.id.localeCompare(b.topic.id));
      return hits.slice(0, filter?.limit ?? 10);
    },
    async check(checkOptions = {}) {
      const problems: DocsProblem[] = [...duplicates];
      const known = new Set(ids());
      for (const entry of [...entries.values()].sort((a, b) => key(a.topic.id, a.topic.locale).localeCompare(key(b.topic.id, b.topic.locale)))) {
        let text: string;
        try {
          text = await body(entry);
        } catch (error) {
          problems.push({
            code: "unreadable_topic",
            id: entry.topic.id,
            locale: entry.topic.locale,
            source: entry.source.id,
            message: `topic "${entry.topic.id}" (${entry.topic.locale}) cannot be read: ${error instanceof Error ? error.message : String(error)}`,
          });
          continue;
        }
        for (const link of topicLinks(text))
          if (!known.has(link))
            problems.push({
              code: "unresolved_link",
              id: entry.topic.id,
              locale: entry.topic.locale,
              link,
              message: `topic "${entry.topic.id}" (${entry.topic.locale}) links to "${link}", which no source gives`,
            });
      }
      const owners = new Map<string, Set<string>>(); // help key to the ids of the topics that list it, in any locale
      for (const entry of entries.values())
        for (const helpKey of entry.topic.context) owners.set(helpKey, (owners.get(helpKey) ?? new Set()).add(entry.topic.id));
      for (const [helpKey, topics] of [...owners].sort(([a], [b]) => a.localeCompare(b)))
        if (topics.size > 1)
          problems.push({
            code: "ambiguous_help_key",
            key: helpKey,
            topics: [...topics].sort(),
            message: `help key "${helpKey}" opens ${topics.size} topics: ${[...topics].sort().join(", ")}`,
          });
      for (const helpKey of checkOptions.helpKeys ?? [])
        if (!owners.has(helpKey))
          problems.push({ code: "unresolved_help_key", key: helpKey, message: `help key "${helpKey}" opens no topic` });
      return problems;
    },
    refresh: load,
    all: () =>
      [...entries.values()]
        .map((entry) => entry.topic)
        .sort((a, b) => a.id.localeCompare(b.id) || a.locale.localeCompare(b.locale)),
  };
}

/** About 160 characters of `text` around the first term it holds. */
function snippet(text: string, terms: string[]): string {
  const lower = text.toLowerCase();
  const at = terms.map((term) => lower.indexOf(term)).filter((i) => i >= 0).sort((a, b) => a - b)[0];
  if (at === undefined) return "";
  const from = Math.max(0, at - 60);
  const piece = text.slice(from, from + 160).replace(/\s+/g, " ").trim();
  return `${from > 0 ? "…" : ""}${piece}${from + 160 < text.length ? "…" : ""}`;
}
