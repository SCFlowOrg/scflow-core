/// <reference types="../../../../yaml.d.ts" />
import { defineModule } from "../../../../src/index.js";
import manifest from "../module.yaml";
import { hello } from "./text.js";

interface Emitter {
  runCommand(command: Record<string, unknown>): Promise<unknown>;
}

export default defineModule(manifest, {
  actions: {
    say_hello: (mcl: Emitter, params: { name: string }) =>
      mcl.runCommand({ kind: "create", schema: "greet.greeting", input: { text: hello(params.name) } }),
  },
  migrations: {
    "1.2.0": () => undefined,
  },
});
