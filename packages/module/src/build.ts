/**
 * The build of one bundle per module package, and the bundle check (see
 * `docs/module-packages.md`, Build the bundle).
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { dirname, join, resolve } from "node:path";
import { modelError, readModuleManifest } from "@scfloworg/core";
import { load as parseYaml } from "js-yaml";
import { rolldown, type Plugin } from "rolldown";
import { checkBundle, formatFindings, type BundleFinding } from "./check.js";
import { BUNDLE_FILE, MANIFEST_FILE, checkModuleCode, importBundle } from "./host.js";

export { ALLOWED_GLOBALS, checkBundle, formatFindings } from "./check.js";
export type { BundleFinding, BundleRule } from "./check.js";

/** The entry of the bundle in the folder of a module package. */
export const ENTRY_FILE = join("src", "module.ts");

/** What `buildModule` built. */
export interface BuildResult {
  /** The path of `dist/module.js`, or `null` for a module with no code. */
  readonly bundle: string | null;
}

const BUILTINS = new Set(builtinModules);

/** The engine stays out of a bundle: the host gives the one instance. */
const isEngine = (source: string) => /^@scfloworg\/core(\/|$)/.test(source);

const isBuiltin = (source: string) => source.startsWith("node:") || BUILTINS.has(source.split("/")[0]);

/** The folder of the nearest `package.json` above a file. */
function packageRoot(file: string): string | null {
  let dir = dirname(file);
  for (;;) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Keeps out of the bundle what a module must not hold, as an import the check
 * refuses: the engine, the Node built-ins and the files of another module
 * package, a folder with its own `module.yaml`. It inlines a `.yaml` import as
 * data.
 */
function modulePlugin(folder: string): Plugin {
  return {
    name: "scflow-module",
    async resolveId(source, importer, options) {
      if (isEngine(source) || isBuiltin(source)) return { id: source, external: true };
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (!resolved || resolved.external) return resolved;
      const root = packageRoot(resolved.id);
      if (root !== null && resolve(root) !== folder && existsSync(join(root, MANIFEST_FILE)))
        return { id: source, external: true };
      return resolved;
    },
    async load(id) {
      if (!/\.ya?ml$/.test(id)) return null;
      const data = parseYaml(await readFile(id, "utf8"));
      return { code: `export default ${JSON.stringify(data)};\n`, moduleType: "js" };
    },
  };
}

/**
 * Builds the bundle of the module package in `folder`: `src/module.ts` to one
 * ES module, `dist/module.js`, with the manifest inlined, `defineModule` and the
 * other libraries of the package bundled in, and a default export.
 *
 * It validates `module.yaml` first. A module with no `src/module.ts` has no
 * bundle: it writes nothing, removes a `dist/module.js` left by an earlier
 * build and returns `bundle: null`. The bundle is checked with `checkBundle`
 * before it is written, then imported and checked against the manifest with
 * `checkModuleCode`; a failure throws `constraint_violation` and leaves no
 * bundle.
 */
export async function buildModule(folder: string): Promise<BuildResult> {
  const root = resolve(folder);
  const manifest = readModuleManifest(readFileSync(join(root, MANIFEST_FILE), "utf8"));
  const target = join(root, BUNDLE_FILE);
  const entry = join(root, ENTRY_FILE);
  if (!existsSync(entry)) {
    rmSync(target, { force: true });
    return { bundle: null };
  }

  const build = await rolldown({
    input: entry,
    platform: "neutral",
    plugins: [modulePlugin(root)],
    resolve: { extensionAlias: { ".js": [".ts", ".js"] } },
    logLevel: "silent",
  });
  let chunks: { code: string }[];
  try {
    const { output } = await build.generate({ format: "es" });
    chunks = output.filter((file): file is (typeof output)[0] => file.type === "chunk");
  } finally {
    await build.close();
  }

  const code = chunks[0]?.code ?? "";
  const findings: BundleFinding[] = checkBundle(code);
  if (chunks.length > 1) findings.push({ rule: "dynamic_import", message: "the bundle splits into several chunks" });
  rmSync(target, { force: true });
  if (findings.length > 0) {
    throw modelError(
      "constraint_violation",
      `the bundle of "${manifest.name}" breaks the bundle check:\n${formatFindings(findings)}`,
    );
  }

  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, code);
  try {
    checkModuleCode(manifest, await importBundle(manifest.name, target, code));
  } catch (error) {
    rmSync(target, { force: true });
    throw error;
  }
  return { bundle: target };
}
