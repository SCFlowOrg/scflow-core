/** What one model accepts (see `docs/ai.md#model-profiles`). A field left out means the provider default. */
export interface ModelProfile {
  /** `false` when the model refuses `temperature`. */
  temperature?: boolean | undefined;
  /** The name of the length limit; `max_tokens` by default. */
  lengthLimit?: "max_tokens" | "max_completion_tokens" | undefined;
  /** `false` when the model reads no image. */
  images?: boolean | undefined;
  /** `false` when the model calls no tool. */
  tools?: boolean | undefined;
}

/** A rule of the table: `match` is a model id where `*` stands for any text. */
export interface ProfileRule {
  match: string;
  profile: ModelProfile;
}

const REASONING: ModelProfile = { temperature: false, lengthLimit: "max_completion_tokens" };

/** The rules every client knows: the reasoning models of OpenAI. */
export const DEFAULT_PROFILES: readonly ProfileRule[] = [
  { match: "o1*", profile: REASONING },
  { match: "o3*", profile: REASONING },
  { match: "o4*", profile: REASONING },
  { match: "gpt-5*", profile: REASONING },
];

function matches(pattern: string, model: string): boolean {
  const source = pattern
    .toLowerCase()
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}$`).test(model);
}

/**
 * The profile of a model: the first rule of `rules`, then of
 * `DEFAULT_PROFILES`, that matches its id, compared without case and without
 * a `provider/` prefix. `undefined` when none matches.
 */
export function profileOf(
  model: string,
  rules: readonly ProfileRule[] = [],
): ModelProfile | undefined {
  const rule = ruleOf(model, [...rules, ...DEFAULT_PROFILES]);
  return rule ? { ...rule.profile } : undefined;
}

/**
 * The first of `rules` whose `match` fits a model id, compared without case
 * and without a `provider/` prefix. Profiles and prices are found this way.
 */
export function ruleOf<Rule extends { match: string }>(
  model: string,
  rules: readonly Rule[],
): Rule | undefined {
  const id = model.toLowerCase();
  const bare = id.slice(id.lastIndexOf("/") + 1);
  return rules.find((candidate) => matches(candidate.match, bare) || matches(candidate.match, id));
}
