// Prints the packages to publish, in dependency order, as one JSON array:
// [{ name, dir, version, tag }]. A package that is `private` is left out.
// A dependency always comes before the packages that depend on it, so a
// registry never holds a version whose dependencies are missing.
//
// `tag` is the npm dist-tag: `next` for a pre-release version (`0.2.0-next.1`),
// `latest` otherwise.
//
// Usage: node scripts/publish-order.mjs

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("../packages/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

const packages = new Map();
for (const dir of readdirSync(root)) {
  const file = join(root, dir, "package.json");
  if (!existsSync(file)) continue;
  const manifest = JSON.parse(readFileSync(file, "utf8"));
  if (manifest.private) continue;
  packages.set(manifest.name, { name: manifest.name, dir: `packages/${dir}`, version: manifest.version, manifest });
}

// Runtime dependencies only: a development dependency is not installed by a user.
const dependenciesOf = (manifest) =>
  [manifest.dependencies, manifest.peerDependencies, manifest.optionalDependencies]
    .flatMap((group) => Object.keys(group ?? {}))
    .filter((name) => packages.has(name));

const ordered = [];
const done = new Set();
const visiting = new Set();

function visit(name) {
  if (done.has(name)) return;
  if (visiting.has(name)) throw new Error(`Dependency cycle through ${name}`);
  visiting.add(name);
  const pkg = packages.get(name);
  for (const dep of dependenciesOf(pkg.manifest).sort()) visit(dep);
  visiting.delete(name);
  done.add(name);
  ordered.push({
    name: pkg.name,
    dir: pkg.dir,
    version: pkg.version,
    tag: pkg.version.includes("-") ? "next" : "latest",
  });
}

for (const name of [...packages.keys()].sort()) visit(name);

console.log(JSON.stringify(ordered, null, 2));
