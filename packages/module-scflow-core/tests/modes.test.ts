import { describe, expect, it } from "vitest";
import { addDurations, leadTimeOnMode } from "../src/index.js";

/** The lead time of a flow on a mode, `docs/spec/implementation.md`, Lead Time Of A Flow. */

describe("addDurations", () => {
  it("sums ISO 8601 durations component by component, with no calendar", () => {
    expect(addDurations(["P1D", "PT12H"])).toBe("P1DT12H");
    expect(addDurations(["PT45M", "PT45M"])).toBe("PT90M");
    expect(addDurations(["P1M", "P2W", "P3D", "PT1.5S", "PT0.25S"])).toBe("P1M2W3DT1.75S");
  });

  it("gives PT0S for no duration, and refuses what is not a duration", () => {
    expect(addDurations([])).toBe("PT0S");
    expect(() => addDurations(["2 days"])).toThrow(/ISO 8601/);
    expect(() => addDurations(["P"])).toThrow(/ISO 8601/);
  });
});

describe("leadTimeOnMode", () => {
  // A round trip A, B, C, A.
  const roundTrip = [
    { actor: "A" },
    { actor: "B", lead_time: "P1D" },
    { actor: "C", lead_time: "PT6H" },
    { actor: "A", lead_time: "P1DT2H" },
  ];

  it("sums the legs from the first stop of the source to the next stop of the destination", () => {
    expect(leadTimeOnMode(roundTrip, "A", "B", false)).toEqual({ direction: "forward", from_index: 0, to_index: 1, lead_time: "P1D" });
    expect(leadTimeOnMode(roundTrip, "A", "C", false)?.lead_time).toBe("P1DT6H");
    expect(leadTimeOnMode(roundTrip, "B", "A", false)).toMatchObject({ from_index: 1, to_index: 3, lead_time: "P1DT8H" });
  });

  it("finds no path against the order of the stops of a one-way mode", () => {
    expect(leadTimeOnMode(roundTrip, "C", "B", false)).toBeUndefined();
    expect(leadTimeOnMode(roundTrip, "A", "D", false)).toBeUndefined();
  });

  it("goes backwards on a bidirectional mode, through the reverse lead times, each defaulting to the lead time", () => {
    const shuttle = [{ actor: "A" }, { actor: "B", lead_time: "P1D", reverse_lead_time: "P2D" }, { actor: "C", lead_time: "PT6H" }];
    expect(leadTimeOnMode(shuttle, "C", "A", true)).toEqual({ direction: "reverse", from_index: 2, to_index: 0, lead_time: "P2DT6H" });
    expect(leadTimeOnMode(shuttle, "A", "C", true)).toMatchObject({ direction: "forward", lead_time: "P1DT6H" });
  });

  it("gives a null lead time when a leg of the path has none, and ignores the lead time of the first stop", () => {
    expect(leadTimeOnMode([{ actor: "A", lead_time: "P9D" }, { actor: "B" }], "A", "B", false)).toMatchObject({ lead_time: null });
    expect(leadTimeOnMode([{ actor: "A", lead_time: "P9D" }, { actor: "B", lead_time: "PT1H" }], "A", "B", false)).toMatchObject({
      lead_time: "PT1H",
    });
  });
});
