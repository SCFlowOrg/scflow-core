import { describe, expect, it } from "vitest";
import { languagesOf, resolveLocalizedText, validateLanguages } from "../src/languages.js";

describe("languages", () => {
  it("validates a list of distinct codes", () => {
    expect(validateLanguages(["fr", "pt-BR"])).toEqual(["fr", "pt-BR"]);
    expect(validateLanguages([])).toEqual([]);
    expect(() => validateLanguages(["fr", "fr"])).toThrow(/twice/);
    expect(() => validateLanguages(["fr-fr"])).toThrow(/language_code/);
    expect(() => validateLanguages("fr")).toThrow(/array/);
  });

  it("reads an absent list as []", () => {
    expect(languagesOf({})).toEqual([]);
    expect(languagesOf(null)).toEqual([]);
    expect(languagesOf({ languages: ["en"] })).toEqual(["en"]);
  });

  it("falls back from a region to its base language, then to the source language", () => {
    const text = { pt: "oi", en: "hi" };
    expect(resolveLocalizedText(text, ["en", "pt"], "pt-BR")).toBe("oi");
    expect(resolveLocalizedText(text, ["en", "pt"], "fr")).toBe("hi");
    expect(resolveLocalizedText({ "pt-BR": "oi" }, ["pt-BR"])).toBe("oi");
    expect(resolveLocalizedText({ de: "x" }, ["en"], "fr")).toBeUndefined();
    expect(resolveLocalizedText(undefined, ["en"])).toBeUndefined();
  });
});
