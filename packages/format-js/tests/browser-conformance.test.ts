import { runConformanceSuite } from "@scfloworg/conformance";
import { createJsPersistenceInterface } from "../src/browser.js";

// Proves the bundler-safe entry point is a fully conformant PersistenceInterface
// on its own, not just for the built-in-dataset scenario browser.test.ts checks
// directly. Registered under a distinct name from format-js.test.ts's "js" and
// repl-conformance.test.ts's "js-repl-conformance" — see format-js.test.ts's own
// comment for why (two registrations of the same name in one process repoint
// the second's dataset state onto the first's).
runConformanceSuite(createJsPersistenceInterface("js-browser"), "js-browser");
