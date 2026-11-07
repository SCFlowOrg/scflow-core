// Builds the bundle of the module scflow:core, src/module.ts to dist/module.js,
// with @scfloworg/module/build. Run by the build script of package.json.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildModule } from "@scfloworg/module/build";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { bundle } = await buildModule(root);
console.log(bundle ? `built ${bundle}` : "scflow:core has no code: no bundle");
