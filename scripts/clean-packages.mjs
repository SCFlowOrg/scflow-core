// Removes the build outputs of every package: dist/ and the .tsbuildinfo
// files. `tsc -b` writes new outputs but never deletes the output of a
// removed source, so build:packages starts clean; the .tsbuildinfo files go
// too, or `tsc -b` would find the projects up to date and write nothing.
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..", "packages");

for (const entry of readdirSync(root, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const dir = join(root, entry.name);
  rmSync(join(dir, "dist"), { recursive: true, force: true });
  for (const file of readdirSync(dir)) {
    if (file.endsWith(".tsbuildinfo")) rmSync(join(dir, file), { force: true });
  }
}
