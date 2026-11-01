import { createTestDocument } from "@scfloworg/core-plugin-core/testing";
import type { ModelActionDefinition } from "@scfloworg/core";
import { ACTIONS, SCHEMAS } from "../src/index.js";

/**
 * Opens a test document with the SCFLOW schemas and returns helpers to run an
 * action by id, query a schema and create an instance directly.
 */
export async function setupActions() {
  const doc = await createTestDocument(SCHEMAS);
  const run = async <T = Record<string, unknown>>(id: string, params: Record<string, unknown>): Promise<T> => {
    const action = ACTIONS.find((candidate) => candidate.id === id) as ModelActionDefinition<any, any> | undefined;
    if (!action) throw new Error(`no action ${id}`);
    return (await action.execute(doc.mcl, doc.locator, params)) as T;
  };
  const query = async (schema: string, filters?: Record<string, unknown>) => {
    const { after } = await doc.mcl.runCommand(doc.locator, {
      kind: "query",
      schema,
      ...(filters ? { filters } : {}),
    });
    return after as unknown as Record<string, any>[];
  };
  const create = async (schema: string, input: Record<string, unknown>): Promise<string> => {
    const { after } = await doc.mcl.runCommand(doc.locator, { kind: "create", schema, input });
    return after[0].id as string;
  };
  return { ...doc, run, query, create };
}
