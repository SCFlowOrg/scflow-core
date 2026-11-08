import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";
import type { AuthoredCommand, AuthoredScript, CommandResult, MclAccess } from "@scfloworg/core";
import { createEnvironment } from "@scfloworg/environment";
import { createJsPersistenceInterface } from "@scfloworg/format-js";
import { defineModule } from "@scfloworg/module";
import { ACTION_BODIES } from "../src/actions/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The module scflow:core from its sources, so these tests need no built bundle. */
const definition = defineModule(load(readFileSync(join(root, "module.yaml"), "utf8")) as never, {
  actions: ACTION_BODIES,
});

let counter = 0;

/** The name of a schema of scflow:core, qualified unless it already is. */
const qualified = (schema: string) => (schema.includes(".") ? schema : `scflow.${schema}`);

/** The command with its schema qualified, whichever form it is written in. */
function qualify(command: AuthoredCommand): AuthoredCommand {
  const form = command as unknown as Record<string, unknown>;
  const key = ["schema", "query", "create", "update", "delete"].find((k) => typeof form[k] === "string");
  return key ? ({ ...form, [key]: qualified(form[key] as string) } as unknown as AuthoredCommand) : command;
}

/**
 * Opens a dataset with the module scflow:core in an environment of its own and
 * returns helpers to run an action by id, as every caller does, to query a
 * schema and to prepare data.
 *
 * `create` and `mcl` write below the actions, to set up a state a test starts
 * from, which may be one no action can reach. They qualify the schema names.
 */
export async function setupActions() {
  const env = createEnvironment({ formats: [createJsPersistenceInterface()] });
  env.modules.install(definition);
  counter += 1;
  const locator = `js:actions${counter}`;
  const dataset = await env.datasets.create({ locator, modules: ["scflow:core"] });

  const mcl = {
    runCommand: (_locator: string, command: AuthoredCommand): Promise<CommandResult> => dataset.query(qualify(command)),
    runScript: (): Promise<CommandResult> => {
      throw new Error("no script in these tests");
    },
  } as unknown as MclAccess & { runScript(locator: string, script: AuthoredScript): Promise<CommandResult> };

  const run = async <T = Record<string, any>>(id: string, params: Record<string, unknown>): Promise<T> =>
    (await dataset.run(id, params)).result as T;
  const query = async (schema: string, filters?: Record<string, unknown>) => {
    const { after } = await dataset.query({
      query: qualified(schema),
      ...(filters ? { filters } : {}),
    } as AuthoredCommand);
    return after as unknown as Record<string, any>[];
  };
  const create = async (schema: string, input: Record<string, unknown>): Promise<string> => {
    const { after } = await dataset.query({ create: qualified(schema), input } as unknown as AuthoredCommand);
    return (after[0] as Record<string, unknown>).id as string;
  };
  return { env, dataset, mcl, locator, run, query, create };
}
