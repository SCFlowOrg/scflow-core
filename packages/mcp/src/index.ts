/**
 * An MCP server on one project of a workspace (see `docs/mcp.md`). It offers
 * the actions of the project as tools and the skills of its environment as
 * prompts, and speaks through any MCP transport; `cli.ts` connects it to the
 * standard streams.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { parametersSchema, runBatch, type ActionRegistry, type Batch } from "@scfloworg/actions";
import type { AuthoredCommand } from "@scfloworg/core";
import { createSkillTool } from "@scfloworg/environment";
import type { Document } from "@scfloworg/workspace";
import type { ProjectHost } from "@scfloworg/workspace/host";

/** What `createMcpServer` takes. */
export interface McpServerOptions {
  host: ProjectHost;
  /** The path of the project, which must exist. */
  path: string;
}

type Args = Record<string, unknown>;

const OBJECT = { type: "object" } as const;
const NO_ARGUMENTS = { type: "object", properties: {} } as const;

const TOOLS = [
  {
    name: "list_actions",
    description: "List the actions of the project. Call describe_action for the parameters of one.",
    inputSchema: NO_ARGUMENTS,
    annotations: { readOnlyHint: true },
  },
  {
    name: "describe_action",
    description: "Give one action of the project, with its parameters as JSON Schema.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    annotations: { readOnlyHint: true },
  },
  {
    name: "run_action",
    description: "Run one action of the project, as one step that undo can reverse. The project is saved.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, params: OBJECT }, required: ["id"] },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  {
    name: "batch",
    description:
      "Run several actions in one transaction, all or nothing. A later step refers to the result of an earlier one, named by `as`, with ${name.path}.",
    inputSchema: {
      type: "object",
      properties: {
        label: { type: "string" },
        commands: {
          type: "array",
          items: {
            type: "object",
            properties: { call: { type: "string" }, with: OBJECT, as: { type: "string" } },
            required: ["call"],
          },
        },
      },
      required: ["commands"],
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  {
    name: "query",
    description: "Read the instances of a schema, by its qualified name, with optional filters.",
    inputSchema: { type: "object", properties: { schema: { type: "string" }, filters: OBJECT }, required: ["schema"] },
    annotations: { readOnlyHint: true },
  },
  {
    name: "undo",
    description: "Undo the last step made through this server. The project is saved.",
    inputSchema: NO_ARGUMENTS,
    annotations: { readOnlyHint: false },
  },
  {
    name: "redo",
    description: "Redo the last undone step. The project is saved.",
    inputSchema: NO_ARGUMENTS,
    annotations: { readOnlyHint: false },
  },
];

function refusal(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function stringArgument(args: Args, name: string): string {
  const value = args[name];
  if (typeof value !== "string") throw refusal("invalid_parameters", `"${name}" must be a string`);
  return value;
}

/** Creates the server of the project at `options.path`. Fails as `workspace.open` does. */
export async function createMcpServer(options: McpServerOptions): Promise<Server> {
  const { host, path } = options;
  let doc: Document = await host.workspace.open(path);

  function visibleAction(id: string) {
    const action = doc.dataset.actions().find((candidate) => candidate.id === id);
    if (!action || action.exposure === "hidden") {
      throw refusal("unknown_action", `The project has no action "${id}"`);
    }
    return action;
  }

  /** Saves. A refused save drops what memory holds, so the server follows the disk again. */
  async function save(): Promise<void> {
    try {
      await doc.save();
    } catch (error) {
      if ((error as { code?: string }).code === "project_changed_on_disk") {
        await doc.close();
        doc = await host.workspace.open(path);
      }
      throw error;
    }
  }

  async function move(direction: "undo" | "redo"): Promise<boolean> {
    const moved = await (direction === "undo" ? doc.undo() : doc.redo());
    if (moved) await save();
    return moved;
  }

  /**
   * The skills offered as prompts: the visible skills of the environment
   * whose `uses` are all visible actions of the project, so a prompt never
   * names an action the client cannot run.
   */
  function offeredSkills() {
    const actions = doc.dataset
      .actions()
      .filter((action) => action.exposure !== "hidden")
      .map((action) => action.id);
    return createSkillTool(host.environment.skills, { actions })?.skills ?? [];
  }

  const handlers: Record<string, (args: Args) => Promise<unknown>> = {
    list_actions: async () =>
      doc.dataset
        .actions()
        .filter((action) => action.exposure !== "hidden")
        .map(({ id, title, description, kind, destructive }) => ({ id, title, description, kind, destructive })),

    describe_action: async (args) => {
      const action = visibleAction(stringArgument(args, "id"));
      const { id, title, description, kind, destructive } = action;
      return { id, title, description, kind, destructive, parameters: parametersSchema(action) };
    },

    run_action: async (args) => {
      const id = stringArgument(args, "id");
      visibleAction(id);
      const outcome = await doc.run(id, args.params);
      if (outcome.changed) await save();
      return { result: outcome.result, changed: outcome.changed };
    },

    batch: async (args) => {
      const label = typeof args.label === "string" ? args.label : "Batch";
      const batch = { commands: args.commands } as unknown as Batch;
      const result = await doc.transaction(label, async (tx) => {
        const registry = {
          run: async (id: string, params: unknown) => {
            visibleAction(id);
            return tx.run(id, params);
          },
        } as unknown as ActionRegistry<unknown>;
        return (await runBatch(registry, batch)).result;
      });
      await save();
      return { result };
    },

    query: async (args) => {
      const schema = stringArgument(args, "schema");
      const filters = args.filters === undefined ? {} : { filters: args.filters };
      return (await doc.dataset.query({ query: schema, ...filters } as unknown as AuthoredCommand)).after;
    },

    undo: async () => ({ undone: await move("undo") }),
    redo: async () => ({ redone: await move("redo") }),
  };

  // One tool at a time: a transaction and a save must not interleave with another call.
  let queue: Promise<unknown> = Promise.resolve();
  const inTurn = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  };

  const server = new Server({ name: "scflow", version: "0.1.0" }, { capabilities: { tools: {}, prompts: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const handler = handlers[request.params.name];
    try {
      if (!handler) throw refusal("unknown_tool", `No tool "${request.params.name}"`);
      const value = await inTurn(() => handler(request.params.arguments ?? {}));
      return { content: [{ type: "text" as const, text: JSON.stringify(value ?? null) }] };
    } catch (error) {
      const { code, message } = error as { code?: string; message?: string };
      const text = JSON.stringify({ error: { code: code ?? "error", message: message ?? String(error) } });
      return { isError: true, content: [{ type: "text" as const, text }] };
    }
  });
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: offeredSkills().map(({ id, title, description }) => ({ name: id, title, description })),
  }));
  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const skill = offeredSkills().find((candidate) => candidate.id === request.params.name);
    if (!skill) throw new McpError(ErrorCode.InvalidParams, `No prompt "${request.params.name}"`);
    const { instructions } = await host.environment.skills.load(skill.id);
    return {
      description: skill.description,
      messages: [{ role: "user" as const, content: { type: "text" as const, text: instructions } }],
    };
  });
  return server;
}
