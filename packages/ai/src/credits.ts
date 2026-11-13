/**
 * Usage estimated in credits (see `docs/ai.md#credits`). One credit is worth
 * 0.01 USD of what the provider asks. With a `byok` connection the user pays
 * the provider: credits are an estimate every host shows the same way, not a
 * charge.
 */

import type { AiUsage } from "./client.js";
import { ruleOf } from "./profiles.js";

/** The credits of a million input and of a million output tokens of a model; `match` as for profiles. */
export interface CreditRate {
  match: string;
  input: number;
  output: number;
}

export interface CreditEstimates {
  /** The date the figures were taken, `YYYY-MM-DD`. */
  asOf: string;
  rates: readonly CreditRate[];
}

/**
 * The shared table: list prices in USD per million tokens, times 100, for
 * standard requests (no batch, cache or priority price). It covers the models
 * `PROVIDERS` suggests whose price was found; updating it is a change of the
 * package, with a new `asOf`.
 */
export const CREDIT_ESTIMATES: CreditEstimates = {
  asOf: "2026-11-13",
  rates: [
    { match: "gpt-5-mini", input: 25, output: 200 },
    { match: "gpt-5", input: 125, output: 1000 },
    // Haiku 5.5 is priced for prompts up to 100K tokens; longer ones cost five times more.
    { match: "claude-haiku-5-5", input: 10, output: 50 },
    { match: "claude-sonnet-5-5", input: 200, output: 1000 },
    { match: "claude-opus-5-5", input: 400, output: 2000 },
    { match: "mistral-small-latest", input: 15, output: 60 },
    { match: "gemini-2.5-flash", input: 30, output: 250 },
    // Gemini 2.5 Pro is priced for prompts up to 200K tokens.
    { match: "gemini-2.5-pro", input: 125, output: 1000 },
    { match: "llama-3.3-70b-versatile", input: 59, output: 79 },
  ],
};

/**
 * The credits of one usage, not rounded: the rate of its model in `rates`,
 * then in `CREDIT_ESTIMATES`. `undefined` when no rule matches or a token
 * count is missing: a cost not known is never counted as nothing.
 */
export function estimateCredits(
  usage: Pick<AiUsage, "model" | "inputTokens" | "outputTokens">,
  rates: readonly CreditRate[] = [],
): number | undefined {
  const { inputTokens, outputTokens } = usage;
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  const rate = ruleOf(usage.model, [...rates, ...CREDIT_ESTIMATES.rates]);
  if (!rate) return undefined;
  return (inputTokens * rate.input + outputTokens * rate.output) / 1_000_000;
}
