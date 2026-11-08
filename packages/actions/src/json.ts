/**
 * The canonical form of JSON, in which the run log holds parameters and
 * results and a replay compares steps: the keys of every object sorted, no
 * white space. As in `JSON.stringify`, a property whose value is `undefined`
 * or a function is left out, and such a value in an array becomes `null`.
 * `undefined` itself gives `null`.
 */
export function canonicalJson(value: unknown): string {
  return write(value) ?? "null";
}

function write(value: unknown): string | undefined {
  if (value === null) return "null";
  if (typeof value === "object" && typeof (value as { toJSON?: unknown }).toJSON === "function") {
    return write((value as { toJSON(): unknown }).toJSON());
  }
  switch (typeof value) {
    case "string":
    case "number":
    case "boolean":
      return JSON.stringify(value);
    case "bigint":
      throw new TypeError("canonicalJson: a bigint has no JSON form");
    case "object": {
      if (Array.isArray(value))
        return `[${value.map((entry) => write(entry) ?? "null").join(",")}]`;
      const record = value as Record<string, unknown>;
      const members = Object.keys(record)
        .sort()
        .flatMap((key) => {
          const text = write(record[key]);
          return text === undefined ? [] : [`${JSON.stringify(key)}:${text}`];
        });
      return `{${members.join(",")}}`;
    }
    default:
      return undefined;
  }
}

/** A deep copy of JSON data, through its JSON text. */
export function copyJson<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}
