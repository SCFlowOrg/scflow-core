import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runScflow, type ScflowIo } from "../src/scflow.js";

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
`;

const temporary: string[] = [];
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const env = {
  SCFLOW_AI_BASE_URL: "https://api.example.test/v1",
  SCFLOW_AI_API_KEY: "sk-test",
  SCFLOW_AI_MODEL: "m",
};

/** A recorded answer of an OpenAI-compatible stream. */
function stream(...payloads: unknown[]): Response {
  const text = [...payloads.map((p) => `data: ${JSON.stringify(p)}\n\n`), "data: [DONE]\n\n"].join(
    "",
  );
  return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const toolCall = (calls: { id: string; name: string; args: unknown }[]) =>
  stream(
    {
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: calls.map((call, index) => ({
              index,
              id: call.id,
              type: "function",
              function: { name: call.name, arguments: JSON.stringify(call.args) },
            })),
          },
          finish_reason: null,
        },
      ],
    },
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  );

const answer = (text: string) =>
  stream(
    { choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  );

function fakeFetch(...answers: Response[]) {
  const requests: Record<string, unknown>[] = [];
  const fetch = async (_url: string, init: { body: string }) => {
    requests.push(JSON.parse(init.body) as Record<string, unknown>);
    const next = answers.shift();
    if (!next) throw new Error("no more answers");
    return next;
  };
  return Object.assign(fetch, { requests });
}

async function scflow(
  args: string[],
  options: { input?: string[]; fetch?: ScflowIo["fetch"]; env?: object } = {},
) {
  const out: string[] = [];
  const err: string[] = [];
  async function* lines() {
    yield* options.input ?? [];
  }
  const code = await runScflow(args, {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    lines: lines(),
    env: (options.env ?? env) as Record<string, string>,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const first = out[0] === undefined ? undefined : (JSON.parse(out[0]) as Record<string, unknown>);
  return { code, first, err };
}

async function created() {
  const root = mkdtempSync(join(tmpdir(), "scflow-ask-"));
  temporary.push(root);
  const modules = join(root, "modules");
  mkdirSync(join(modules, "tasks"), { recursive: true });
  writeFileSync(join(modules, "tasks", "module.yaml"), moduleYaml);
  const project = join(root, "project");
  const result = await scflow([
    project,
    "create",
    "--type",
    "acme:tasks",
    "--title",
    "Demo",
    "--module",
    "acme:tasks",
    "--modules",
    modules,
  ]);
  expect(result.code).toBe(0);
  return { project, modules };
}

function snapshot(project: string): string {
  return readdirSync(project)
    .sort()
    .map((name) => readFileSync(join(project, name), "utf8"))
    .join("\n");
}

const twoTasks = () =>
  toolCall([
    { id: "c1", name: "tasks-create_task", args: { title: "One" } },
    { id: "c2", name: "tasks-create_task", args: { title: "Two" } },
  ]);

describe("scflow ask", () => {
  it("changes the project through its actions and saves it, with --yes", async () => {
    const d = await created();
    const fetch = fakeFetch(twoTasks(), answer("Two tasks created."));
    const result = await scflow(
      [d.project, "ask", "Create two tasks", "--yes", "--modules", d.modules],
      { fetch },
    );
    expect(result.code).toBe(0);
    expect(result.first).toMatchObject({
      text: "Two tasks created.",
      stopped: "done",
      turns: 2,
      changed: true,
    });
    expect((result.first?.written as unknown[]).length).toBeGreaterThan(0);
    expect(result.first?.calls).toMatchObject([
      { action: "tasks/create_task", params: { title: "One" }, approved: true },
      { action: "tasks/create_task", params: { title: "Two" }, approved: true },
    ]);
    const tools = fetch.requests[0]?.tools as { function: { name: string } }[];
    expect(tools.map((tool) => tool.function.name)).toContain("tasks-create_task");
    expect(fetch.requests[0]?.model).toBe("m");

    const query = await scflow([d.project, "query", "tasks.task", "--modules", d.modules]);
    expect(
      (query.first as unknown as { title: string }[]).map((task) => task.title).sort(),
    ).toEqual(["One", "Two"]);
  });

  it("tells the model the languages of the project", async () => {
    const d = await created();
    await scflow([d.project, "languages", '["fr","en"]', "--modules", d.modules]);
    const fetch = fakeFetch(answer("Nothing to do."));
    await scflow([d.project, "ask", "Hello", "--modules", d.modules], { fetch });
    const system = (fetch.requests[0]?.messages as { role: string; content: string }[])[0];
    expect(system?.content).toContain("fr, en");
    expect(system?.content).toContain("source language being fr");
  });

  it("asks one approval for the calls of an answer on the terminal", async () => {
    const d = await created();
    const fetch = fakeFetch(twoTasks(), answer("Done."));
    const result = await scflow([d.project, "ask", "Create two tasks", "--modules", d.modules], {
      fetch,
      input: ["y"],
    });
    expect(result.code).toBe(0);
    expect(result.err.filter((line) => line.includes("Approve"))).toHaveLength(1);
    expect(result.first).toMatchObject({ changed: true });
  });

  it("refuses the calls without approval, tells the model, and writes nothing", async () => {
    const d = await created();
    const before = snapshot(d.project);
    const fetch = fakeFetch(twoTasks(), answer("Nothing done."));
    const result = await scflow([d.project, "ask", "Create two tasks", "--modules", d.modules], {
      fetch,
      input: ["n"],
    });
    expect(result.code).toBe(0);
    expect(result.first).toMatchObject({ changed: false, written: [] });
    expect(result.first?.calls).toMatchObject([{ approved: false }, { approved: false }]);
    const second = fetch.requests[1]?.messages as { role: string; content: string }[];
    expect(second.filter((m) => m.role === "tool").map((m) => m.content)).toEqual([
      JSON.stringify({ error: "The user refused this call." }),
      JSON.stringify({ error: "The user refused this call." }),
    ]);
    expect(snapshot(d.project)).toBe(before);
  });

  it("is a wrong command line without a key or a model", async () => {
    const d = await created();
    const result = await scflow([d.project, "ask", "Hi", "--modules", d.modules], {
      env: { SCFLOW_AI_MODEL: "m" },
    });
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toContain("SCFLOW_AI_API_KEY");
  });

  it("refuses with the kind of an error of the model, and saves nothing", async () => {
    const d = await created();
    const before = snapshot(d.project);
    const unauthorized = new Response(
      JSON.stringify({ error: { message: "Incorrect API key provided" } }),
      {
        status: 401,
      },
    );
    const result = await scflow([d.project, "ask", "Hi", "--yes", "--modules", d.modules], {
      fetch: fakeFetch(twoTasks(), unauthorized),
    });
    expect(result.code).toBe(1);
    expect(JSON.parse(result.err.at(-1) as string)).toMatchObject({
      error: { code: "ai_auth", message: expect.stringContaining("Incorrect API key") },
    });
    expect(snapshot(d.project)).toBe(before);
  });
});

/** The folder of the module scflow:core, loaded with its built bundle and its skill. */
const scflowCore = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "module-scflow-core");

// Each test loads and checks the bundle of scflow:core, twice.
describe("scflow ask with skills", { timeout: 30000 }, () => {
  async function model() {
    const root = mkdtempSync(join(tmpdir(), "scflow-ask-skill-"));
    temporary.push(root);
    const project = join(root, "model");
    const result = await scflow([
      project,
      "create",
      "--type",
      "scflow:model",
      "--title",
      "Model",
      "--module",
      "scflow:core",
      "--modules",
      scflowCore,
    ]);
    expect(result.code).toBe(0);
    return project;
  }

  it("lists the skill in the prompt, offers use_skill, and gives the body to the model", async () => {
    const project = await model();
    const before = snapshot(project);
    const fetch = fakeFetch(
      toolCall([{ id: "s1", name: "use_skill", args: { skillId: "scflow/image_to_model" } }]),
      answer("I will follow the method."),
    );
    const result = await scflow([project, "ask", "Model this diagram", "--modules", scflowCore], {
      fetch,
    });
    expect(result.code).toBe(0);

    const first = fetch.requests[0]?.messages as { role: string; content: string }[];
    const system = first.find((m) => m.role === "system")?.content ?? "";
    expect(system).toContain("- scflow/image_to_model: Image to model. Use when creating");
    expect(system).not.toContain("# Create or refine a SCFLOW model");
    const tools = fetch.requests[0]?.tools as {
      function: { name: string; parameters: { properties: { skillId: { enum: string[] } } } };
    }[];
    const useSkill = tools.find((tool) => tool.function.name === "use_skill");
    expect(useSkill?.function.parameters.properties.skillId.enum).toEqual([
      "scflow/image_to_model",
      "scflow/physical_to_information_flows",
    ]);

    // Loading a skill asks no approval, even without --yes, and changes nothing.
    expect(result.err.some((line) => line.includes("Approve"))).toBe(false);
    const second = fetch.requests[1]?.messages as { role: string; content: string }[];
    const loaded = JSON.parse(second.find((m) => m.role === "tool")?.content ?? "null");
    expect(loaded).toEqual({
      skillId: "scflow/image_to_model",
      title: "Image to model",
      instructions: readFileSync(join(scflowCore, "skills", "image-to-model.md"), "utf8"),
    });
    expect(result.first).toMatchObject({
      text: "I will follow the method.",
      calls: [
        { action: "use_skill", params: { skillId: "scflow/image_to_model" }, approved: true },
      ],
      changed: false,
      written: [],
    });
    expect(snapshot(project)).toBe(before);
  });

  it("offers no skill whose actions the project lacks", async () => {
    const d = await created();
    const fetch = fakeFetch(answer("Nothing to do."));
    const result = await scflow([d.project, "ask", "Hi", "--modules", d.modules], { fetch });
    expect(result.code).toBe(0);
    const tools = fetch.requests[0]?.tools as { function: { name: string } }[];
    expect(tools.map((tool) => tool.function.name)).not.toContain("use_skill");
    const system = (fetch.requests[0]?.messages as { role: string; content: string }[])[0]?.content;
    expect(system).not.toContain("use_skill");
  });
});
