import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { runScflow } from "@scfloworg/repl/scflow";
import { createProjectHost } from "@scfloworg/workspace/host";
import { createMcpServer } from "../src/index.js";

/** The folder of the module scflow:core, loaded with its built bundle and its skills. */
const scflowCore = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scflow-core");

const moduleYaml = `
name: acme:tasks
namespace: tasks
version: 1.0.0
mcl: ^1.0
title: Tasks
schemas:
  - name: task
    is_root:
    properties:
      - name: title
        type: string
actions:
  - id: tasks/peek
    title: Internal
    kind: read
    exposure: hidden
    body:
      commands:
        - query: task
`;

const temporary: string[] = [];
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function cli(...args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  async function* lines(): AsyncGenerator<string> {}
  const code = await runScflow(args, { out: (l) => out.push(l), err: (l) => err.push(l), lines: lines() });
  return { code, out, err };
}

async function project() {
  const root = mkdtempSync(join(tmpdir(), "scflow-mcp-"));
  temporary.push(root);
  const modules = join(root, "modules");
  mkdirSync(join(modules, "tasks"), { recursive: true });
  writeFileSync(join(modules, "tasks", "module.yaml"), moduleYaml);
  const path = join(root, "project");
  const created = await cli(
    path, "create", "--type", "acme:tasks", "--title", "Demo", "--module", "acme:tasks", "--modules", modules,
  );
  expect(created.code).toBe(0);
  return { path, modules };
}

async function connect({ path, modules }: { path: string; modules: string }) {
  const server = await createMcpServer({ host: await createProjectHost({ modules }), path });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientSide);
  return {
    client,
    async call(name: string, args: Record<string, unknown> = {}) {
      const result = await client.callTool({ name, arguments: args });
      const text = (result.content as { text: string }[])[0]?.text as string;
      return { isError: result.isError === true, value: JSON.parse(text) as any };
    },
  };
}

function snapshot(path: string): [string, string][] {
  return readdirSync(path)
    .sort()
    .filter((name) => statSync(join(path, name)).isFile())
    .map((name) => [name, readFileSync(join(path, name), "utf8")]);
}

describe("acceptance of phase D", () => {
  it("changes a project by the CLI, then through MCP, and loses no section", async () => {
    const dirs = await project();
    writeFileSync(join(dirs.path, "ui.json"), '{ "version": 1, "views": ["a"] }');
    writeFileSync(join(dirs.path, "ai-assistant.json"), '{"version":3}');
    mkdirSync(join(dirs.path, "attachments"));
    writeFileSync(join(dirs.path, "attachments", "plan.bin"), "binary content");

    const run = await cli(dirs.path, "run", "tasks/create_task", '{"title":"By the CLI"}', "--modules", dirs.modules);
    expect(run.code).toBe(0);

    const { call } = await connect(dirs);
    expect((await call("run_action", { id: "tasks/create_task", params: { title: "Through MCP" } })).isError).toBe(false);

    const rows = JSON.parse((await cli(dirs.path, "query", "tasks.task", "--modules", dirs.modules)).out[0] as string);
    expect(rows.map((row: { title: string }) => row.title).sort()).toEqual(["By the CLI", "Through MCP"]);

    expect(readFileSync(join(dirs.path, "ui.json"), "utf8")).toBe('{ "version": 1, "views": ["a"] }');
    expect(readFileSync(join(dirs.path, "ai-assistant.json"), "utf8")).toBe('{"version":3}');
    expect(readFileSync(join(dirs.path, "attachments", "plan.bin"), "utf8")).toBe("binary content");
  });

  it("gives identical bytes when nothing changed", async () => {
    const dirs = await project();
    await cli(dirs.path, "run", "tasks/create_task", '{"title":"One"}', "--modules", dirs.modules);
    writeFileSync(join(dirs.path, "ui.json"), '{ "version": 1 }');
    const before = snapshot(dirs.path);

    const { call } = await connect(dirs);
    await call("list_actions");
    await call("query", { schema: "tasks.task" });
    await cli(dirs.path, "actions", "--modules", dirs.modules);
    await cli(dirs.path, "query", "tasks.task", "--modules", dirs.modules);

    expect(snapshot(dirs.path)).toEqual(before);
  });
});

describe("languages", () => {
  it("reads [] when not stated, sets the list, saves it and undoes it", async () => {
    const dirs = await project();
    const { call } = await connect(dirs);
    expect((await call("get_languages")).value).toEqual({ languages: [] });
    expect((await call("set_languages", { languages: ["fr", "en"] })).value).toEqual({ languages: ["fr", "en"], changed: true });
    const read = await cli(dirs.path, "languages", "--modules", dirs.modules);
    expect(JSON.parse(read.out[0] as string)).toEqual({ languages: ["fr", "en"] });
    await call("undo");
    expect((await call("get_languages")).value).toEqual({ languages: [] });
  });

  it("refuses a duplicate and a bad code, and changes nothing", async () => {
    const { call } = await connect(await project());
    await call("set_languages", { languages: ["fr"] });
    for (const languages of [["en", "en"], ["english"]]) {
      const refused = await call("set_languages", { languages });
      expect(refused.isError).toBe(true);
      expect(refused.value.error.code).toBe("constraint_violation");
    }
    expect((await call("get_languages")).value).toEqual({ languages: ["fr"] });
  });
});

describe("tools", () => {
  it("exposes a catalogue, not one tool per action", async () => {
    const { client } = await connect(await project());
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "batch", "describe_action", "get_languages", "list_actions", "query", "redo", "run_action", "set_languages", "undo",
    ]);
    expect(tools.find((tool) => tool.name === "query")?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((tool) => tool.name === "run_action")?.annotations?.readOnlyHint).toBe(false);
  });

  it("lists and describes an action", async () => {
    const { call } = await connect(await project());
    const listed = (await call("list_actions")).value as { id: string }[];
    expect(listed.map((action) => action.id)).toContain("tasks/create_task");
    const described = (await call("describe_action", { id: "tasks/create_task" })).value;
    expect(described.parameters.properties).toHaveProperty("title");
  });

  it("hides an action the model hides, also in a batch", async () => {
    const { call } = await connect(await project());
    const listed = (await call("list_actions")).value as { id: string }[];
    expect(listed.map((action) => action.id)).not.toContain("tasks/peek");
    expect((await call("run_action", { id: "tasks/peek" })).value.error.code).toBe("unknown_action");
    expect((await call("batch", { commands: [{ call: "tasks/peek" }] })).value.error.code).toBe("unknown_action");
  });

  it("gives an error an AI can act on", async () => {
    const { call } = await connect(await project());
    const refused = await call("run_action", { id: "tasks/create_task", params: { title: 12 } });
    expect(refused.isError).toBe(true);
    expect(refused.value.error.code).toBe("invalid_parameters");
    expect((await call("describe_action", { id: "tasks/none" })).value.error.code).toBe("unknown_action");
  });

  it("saves each change", async () => {
    const dirs = await project();
    const { call } = await connect(dirs);
    await call("run_action", { id: "tasks/create_task", params: { title: "Saved" } });
    expect(readFileSync(join(dirs.path, "data.json"), "utf8")).toContain("Saved");
  });

  it("undoes and redoes, on disk", async () => {
    const dirs = await project();
    const { call } = await connect(dirs);
    await call("run_action", { id: "tasks/create_task", params: { title: "Saved" } });
    expect((await call("undo")).value.undone).toBe(true);
    expect(readFileSync(join(dirs.path, "data.json"), "utf8")).not.toContain("Saved");
    expect((await call("redo")).value.redone).toBe(true);
    expect(readFileSync(join(dirs.path, "data.json"), "utf8")).toContain("Saved");
    expect((await call("redo")).value.redone).toBe(false);
  });

  it("runs a batch in one step, with references", async () => {
    const dirs = await project();
    const { call } = await connect(dirs);
    const done = await call("batch", {
      label: "Two",
      commands: [
        { call: "tasks/create_task", with: { title: "First" }, as: "first" },
        { call: "tasks/create_task", with: { title: "After ${first.title}" } },
      ],
    });
    expect(done.isError).toBe(false);
    const rows = (await call("query", { schema: "tasks.task" })).value as { title: string }[];
    expect(rows.map((row) => row.title).sort()).toEqual(["After First", "First"]);
    await call("undo");
    expect(((await call("query", { schema: "tasks.task" })).value as unknown[]).length).toBe(0);
  });

  it("rolls a refused batch back and writes nothing", async () => {
    const dirs = await project();
    const { call } = await connect(dirs);
    const before = snapshot(dirs.path);
    const refused = await call("batch", {
      commands: [
        { call: "tasks/create_task", with: { title: "First" } },
        { call: "tasks/create_task", with: { title: 12 } },
      ],
    });
    expect(refused.isError).toBe(true);
    expect(snapshot(dirs.path)).toEqual(before);
    expect(((await call("query", { schema: "tasks.task" })).value as unknown[]).length).toBe(0);
  });

  it("filters a query", async () => {
    const { call } = await connect(await project());
    await call("run_action", { id: "tasks/create_task", params: { title: "A" } });
    await call("run_action", { id: "tasks/create_task", params: { title: "B" } });
    const rows = await call("query", { schema: "tasks.task", filters: { title: "B" } });
    expect((rows.value as unknown[]).length).toBe(1);
  });
});

describe("a change made on disk meanwhile", () => {
  it("refuses the change, reads the project again, and works on retry", async () => {
    const dirs = await project();
    const { call } = await connect(dirs);
    await call("run_action", { id: "tasks/create_task", params: { title: "Mine" } });

    const other = await cli(dirs.path, "run", "tasks/create_task", '{"title":"Other"}', "--modules", dirs.modules);
    expect(other.code).toBe(0);

    const refused = await call("run_action", { id: "tasks/create_task", params: { title: "Late" } });
    expect(refused.value.error.code).toBe("project_changed_on_disk");
    const onDisk = readFileSync(join(dirs.path, "data.json"), "utf8");
    expect(onDisk).toContain("Other");
    expect(onDisk).not.toContain("Late");

    expect((await call("run_action", { id: "tasks/create_task", params: { title: "Late" } })).isError).toBe(false);
    const rows = (await call("query", { schema: "tasks.task" })).value as { title: string }[];
    expect(rows.map((row) => row.title).sort()).toEqual(["Late", "Mine", "Other"]);
  });
});

// Each test loads and checks the bundle of scflow:core, twice.
describe("prompts", { timeout: 30000 }, () => {
  /** A project on scflow:core, served by a host where acme:tasks is installed too. */
  async function scflowProject() {
    const { path: tasks, modules } = await project();
    const path = join(dirname(tasks), "model");
    const created = await cli(
      path, "create", "--type", "scflow:model", "--title", "Model", "--module", "scflow:core", "--modules", scflowCore,
    );
    expect(created.code).toBe(0);
    return { path, tasks, modules };
  }

  async function connectBoth(path: string, modules: string) {
    const host = await createProjectHost({ modules });
    await host.environment.modules.load(scflowCore);
    const server = await createMcpServer({ host, path });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(clientSide);
    return client;
  }

  it("declares the prompts capability", async () => {
    const { path, modules } = await scflowProject();
    const client = await connectBoth(path, modules);
    expect(client.getServerCapabilities()?.prompts).toBeDefined();
  });

  it("lists and gets the skill scflow/image_to_model, its body as the message", async () => {
    const { path, modules } = await scflowProject();
    const client = await connectBoth(path, modules);
    const { prompts } = await client.listPrompts();
    expect(prompts).toEqual([
      {
        name: "scflow/image_to_model",
        title: "Image to model",
        description: expect.stringContaining("supply-chain diagram"),
      },
    ]);
    const prompt = await client.getPrompt({ name: "scflow/image_to_model" });
    const body = readFileSync(join(scflowCore, "skills", "image-to-model.md"), "utf8");
    expect(prompt.description).toBe(prompts[0]?.description);
    expect(prompt.messages).toEqual([{ role: "user", content: { type: "text", text: body } }]);
  });

  it("offers no skill whose actions the project lacks", async () => {
    const { tasks, modules } = await scflowProject();
    const client = await connectBoth(tasks, modules);
    expect((await client.listPrompts()).prompts).toEqual([]);
    await expect(client.getPrompt({ name: "scflow/image_to_model" })).rejects.toThrow(/No prompt/);
  });
});
