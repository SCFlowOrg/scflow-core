import { describe, expect, it } from "vitest";
import { creditsOf, type AiUsage, type CreditPolicy } from "../src/index.js";

const usage = (model: string, inputTokens?: number, outputTokens?: number): AiUsage => ({
  model,
  connection: "byok",
  durationMs: 1,
  outcome: "ok",
  ...(inputTokens !== undefined ? { inputTokens } : {}),
  ...(outputTokens !== undefined ? { outputTokens } : {}),
});

const policy: CreditPolicy = {
  prices: [
    { match: "small-*", input: 1, output: 4 },
    { match: "large-1", input: 10, output: 40 },
    { match: "*", input: 100, output: 100 },
  ],
  creditsPerUnit: 1000,
};

describe("creditsOf", () => {
  it("prices input and output tokens per million, in credits", () => {
    // (2M × 1 + 0.5M × 4) / 1M × 1000
    expect(creditsOf(usage("small-2", 2_000_000, 500_000), policy)).toBe(4000);
    // (1000 × 10 + 1000 × 40) / 1M × 1000
    expect(creditsOf(usage("large-1", 1000, 1000), policy)).toBeCloseTo(50);
  });

  it("adds the margin to the price of the provider", () => {
    expect(creditsOf(usage("small-2", 1_000_000, 0), { ...policy, margin: 0.25 })).toBe(1250);
  });

  it("takes the first rule that matches, without case or provider prefix", () => {
    expect(creditsOf(usage("OpenRouter/Small-X", 1_000_000, 0), policy)).toBe(1000);
    expect(creditsOf(usage("other", 1_000_000, 0), policy)).toBe(100_000);
  });

  it("is undefined when no rule matches, or a token count is missing", () => {
    const strict = { ...policy, prices: policy.prices.slice(0, 2) };
    expect(creditsOf(usage("other", 10, 10), strict)).toBeUndefined();
    expect(creditsOf(usage("small-2", 10), policy)).toBeUndefined();
    expect(creditsOf(usage("small-2", undefined, 10), policy)).toBeUndefined();
    expect(creditsOf(usage("small-2"), policy)).toBeUndefined();
  });

  it("counts zero tokens as a known cost of nothing", () => {
    expect(creditsOf(usage("small-2", 0, 0), policy)).toBe(0);
  });
});
