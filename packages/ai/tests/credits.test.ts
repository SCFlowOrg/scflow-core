import { describe, expect, it } from "vitest";
import { CREDIT_ESTIMATES, estimateCredits, PROVIDERS, type AiUsage } from "../src/index.js";

const usage = (model: string, inputTokens?: number, outputTokens?: number): AiUsage => ({
  model,
  connection: "byok",
  durationMs: 1,
  outcome: "ok",
  ...(inputTokens !== undefined ? { inputTokens } : {}),
  ...(outputTokens !== undefined ? { outputTokens } : {}),
});

const rates = [
  { match: "small-*", input: 100, output: 400 },
  { match: "gpt-5", input: 1, output: 1 },
];

describe("estimateCredits", () => {
  it("prices input and output tokens per million, in credits", () => {
    // (2M × 100 + 0.5M × 400) / 1M
    expect(estimateCredits(usage("small-2", 2_000_000, 500_000), rates)).toBe(400);
  });

  it("uses the shared table, after the rates of the host", () => {
    // claude-opus-5-5: 400 and 2000 credits per million
    expect(estimateCredits(usage("claude-opus-5-5", 1_000_000, 1_000_000))).toBe(2400);
    expect(estimateCredits(usage("gpt-5", 1_000_000, 0), rates)).toBe(1);
    expect(estimateCredits(usage("gpt-5", 1_000_000, 0))).toBe(125);
  });

  it("matches without case or provider prefix, and tells gpt-5 from gpt-5-mini", () => {
    expect(estimateCredits(usage("OpenRouter/Small-X", 1_000_000, 0), rates)).toBe(100);
    expect(estimateCredits(usage("gpt-5-mini", 1_000_000, 0))).toBe(25);
  });

  it("is undefined when no rule matches, or a token count is missing", () => {
    expect(estimateCredits(usage("llama3", 10, 10))).toBeUndefined();
    expect(estimateCredits(usage("small-2", 10), rates)).toBeUndefined();
    expect(estimateCredits(usage("small-2", undefined, 10), rates)).toBeUndefined();
    expect(estimateCredits(usage("small-2"), rates)).toBeUndefined();
  });

  it("counts zero tokens as a known cost of nothing", () => {
    expect(estimateCredits(usage("small-2", 0, 0), rates)).toBe(0);
  });
});

describe("the shared table", () => {
  it("is dated, and has positive rates with unique matches", () => {
    expect(CREDIT_ESTIMATES.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const matches = CREDIT_ESTIMATES.rates.map((rate) => rate.match);
    expect(new Set(matches).size).toBe(matches.length);
    for (const rate of CREDIT_ESTIMATES.rates) {
      expect(rate.input).toBeGreaterThan(0);
      expect(rate.output).toBeGreaterThan(0);
    }
  });

  it("covers the fast model suggested by each paid provider that suggests one", () => {
    for (const provider of PROVIDERS.filter((p) => p.needsKey && p.models.length)) {
      expect(estimateCredits(usage(provider.models[0]!, 1, 1)), provider.id).toBeDefined();
    }
  });
});
