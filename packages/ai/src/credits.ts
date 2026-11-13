/**
 * Usage counted in credits, a unit of the host (see `docs/ai.md#credits`).
 * The package holds no price: the host gives the prices of the providers,
 * what a unit of their currency is worth in credits, and its margin.
 */

import type { AiUsage } from "./client.js";
import { ruleOf } from "./profiles.js";

/** The price a provider asks for a model, per million tokens; `match` as for profiles. */
export interface PriceRule {
  match: string;
  input: number;
  output: number;
}

export interface CreditPolicy {
  /** Prices in one currency for the whole table; the first rule that matches wins. */
  prices: readonly PriceRule[];
  /** The credits one unit of that currency is worth. */
  creditsPerUnit: number;
  /** The share added to the price of the provider: `0.2` adds 20 %. `0` by default. */
  margin?: number | undefined;
}

/**
 * The credits of one usage, not rounded. `undefined` when no rule matches the
 * model or a token count is missing: a cost not known is never counted as nothing.
 */
export function creditsOf(
  usage: Pick<AiUsage, "model" | "inputTokens" | "outputTokens">,
  policy: CreditPolicy,
): number | undefined {
  const { inputTokens, outputTokens } = usage;
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  const price = ruleOf(usage.model, policy.prices);
  if (!price) return undefined;
  const cost = (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
  return cost * policy.creditsPerUnit * (1 + (policy.margin ?? 0));
}
