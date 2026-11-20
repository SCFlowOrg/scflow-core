/** One stop of a mode, as {@link leadTimeOnMode} reads it. */
export interface StopInput {
  /** Id of the actor of the stop. */
  actor: string;
  /** ISO 8601 duration of the leg from the previous stop to this one; ignored on the first stop. */
  lead_time?: string | null;
  /** ISO 8601 duration of the same leg travelled backwards; `lead_time` when absent. */
  reverse_lead_time?: string | null;
}

/** A path between two stops of a mode, found by {@link leadTimeOnMode}. */
export interface ModePath {
  /** `forward` follows the order of the stops, `reverse` goes against it. */
  direction: "forward" | "reverse";
  /** Index of the stop the path starts from, in the list of stops. */
  from_index: number;
  /** Index of the stop the path ends at. */
  to_index: number;
  /** Sum of the lead times of the legs of the path; `null` when a leg has none. */
  lead_time: string | null;
}

/**
 * Finds the path of a mode from a stop of the actor `from` to a stop of the actor `to`, and sums
 * the lead times of its legs.
 *
 * The forward path starts at the first stop of `from` that a later stop of `to` follows, and ends
 * at the first such stop of `to`. When there is none and `bidirectional` is true, the reverse path
 * is the forward path of the stops taken in reverse order, and sums the reverse lead times, each
 * defaulting to the lead time of its stop.
 *
 * @param stops The stops of one mode, in the order of their `sequence`.
 * @param from Id of the actor the path starts from.
 * @param to Id of the actor the path ends at.
 * @param bidirectional Whether the mode serves its stops in both orders.
 * @returns The path, or `undefined` when the mode has none from `from` to `to`.
 */
export function leadTimeOnMode(
  stops: readonly StopInput[],
  from: string,
  to: string,
  bidirectional: boolean,
): ModePath | undefined {
  for (let i = 0; i < stops.length; i += 1) {
    if (stops[i].actor !== from) continue;
    for (let j = i + 1; j < stops.length; j += 1) {
      if (stops[j].actor === to) {
        const legs = stops.slice(i + 1, j + 1).map((stop) => stop.lead_time ?? null);
        return { direction: "forward", from_index: i, to_index: j, lead_time: sumLegs(legs) };
      }
    }
  }
  if (!bidirectional) return undefined;
  for (let i = stops.length - 1; i >= 0; i -= 1) {
    if (stops[i].actor !== from) continue;
    for (let j = i - 1; j >= 0; j -= 1) {
      if (stops[j].actor === to) {
        const legs = stops.slice(j + 1, i + 1).map((stop) => stop.reverse_lead_time ?? stop.lead_time ?? null);
        return { direction: "reverse", from_index: i, to_index: j, lead_time: sumLegs(legs) };
      }
    }
  }
  return undefined;
}

/**
 * The pattern of an ISO 8601 duration, `PnYnMnWnDTnHnMnS`, as the `duration` scalar type of
 * `mcl:core` declares it.
 */
export const DURATION_PATTERN = String.raw`^P(?=.)((\d+Y)|(\d+M)|(\d+W)|(\d+D))*(T(?=.)((\d+H)|(\d+M)|(\d+(\.\d+)?S))*)?$`;

/** The designators of a duration, date ones then time ones, in the order they are written. */
const DATE_DESIGNATORS = ["Y", "M", "W", "D"];
const TIME_DESIGNATORS = ["H", "M", "S"];

/**
 * Sums ISO 8601 durations component by component: years with years, hours with hours. The sum
 * needs no calendar, so `P1D` plus `PT12H` is `P1DT12H` and two `PT45M` make `PT90M`.
 *
 * @returns The sum, `PT0S` for no duration.
 * @throws When a value is not an ISO 8601 duration.
 */
export function addDurations(durations: readonly string[]): string {
  const date = [0, 0, 0, 0];
  const time = [0, 0, 0];
  const pattern = new RegExp(DURATION_PATTERN);
  for (const duration of durations) {
    if (!pattern.test(duration)) {
      throw new Error(`"${duration}" is not an ISO 8601 duration`);
    }
    const [datePart, timePart = ""] = duration.slice(1).split("T");
    for (const [, value, unit] of datePart.matchAll(/(\d+)([YMWD])/g)) date[DATE_DESIGNATORS.indexOf(unit)] += Number(value);
    for (const [, value, unit] of timePart.matchAll(/(\d+(?:\.\d+)?)([HMS])/g)) time[TIME_DESIGNATORS.indexOf(unit)] += Number(value);
  }
  const write = (values: number[], units: string[]) =>
    values.map((value, k) => (value === 0 ? "" : `${round(value)}${units[k]}`)).join("");
  const datePart = write(date, DATE_DESIGNATORS);
  const timePart = write(time, TIME_DESIGNATORS);
  if (datePart === "" && timePart === "") return "PT0S";
  return `P${datePart}${timePart === "" ? "" : `T${timePart}`}`;
}

function sumLegs(legs: readonly (string | null)[]): string | null {
  return legs.some((leg) => leg === null) ? null : addDurations(legs as string[]);
}

/** A sum of decimal seconds without the noise of floating point. */
function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
