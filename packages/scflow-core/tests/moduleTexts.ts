import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string) => readFileSync(join(root, file), "utf8");

/** The bodies of the skills of scflow:core, by name, as `src/module.ts` gives them. */
export const SKILL_TEXTS = {
  image_to_model: read("skills/image-to-model.md"),
  physical_to_information_flows: read("skills/physical-to-information-flows.md"),
};

/** The bodies of the documentation topics of scflow:core, by file, as `src/module.ts` gives them. */
export function docTexts(): Record<string, string> {
  const manifest = load(read("module.yaml")) as { docs?: { file: string }[] };
  return Object.fromEntries((manifest.docs ?? []).map((entry) => [entry.file, read(entry.file)]));
}
