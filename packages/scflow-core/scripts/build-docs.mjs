// Writes the generated reference topics of the module scflow:core, the concepts
// and the action catalogue, to docs/reference/, from module.yaml with
// generateReference of @scfloworg/module. Run by the build script of
// package.json before the bundle; the generated files are committed and
// tests/reference.test.ts fails when they are stale. Needs the packages built.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readModuleManifest } from "@scfloworg/core";
import { generateReference } from "@scfloworg/module/reference";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = readModuleManifest(readFileSync(join(root, "module.yaml"), "utf8"));
for (const { topic, body } of generateReference(manifest)) {
  const file = join(root, topic.file);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
  console.log(`generated ${topic.file}`);
}
