import { runReplConformanceSuite } from "@scfloworg/repl-conformance";
import { createJsPersistenceInterface } from "../src/index.js";

// Named distinctly from format-js.test.ts's own "js" registration — two
// registrations of the same name in one process would repoint the second
// one's dataset state onto the first's. See @scfloworg/repl-conformance's
// README for why.
runReplConformanceSuite(createJsPersistenceInterface("js-repl-conformance"), "js-repl-conformance");
