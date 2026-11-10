/**
 * `scflow <project> ask <prompt>`: a language model works on the project
 * through its actions, with the skills of the environment that rely on them
 * (see `docs/scflow.md#asking-a-model`).
 */

import { actionIdOfTool, toAiTools } from "@scfloworg/actions";
import { AiError, createAiClient, runAgent, type AiFetch, type AiToolCall } from "@scfloworg/ai";
import {
  createSkillTool,
  SKILL_TOOL,
  type SkillCatalogue,
  type SkillTool,
} from "@scfloworg/environment";
import type { Document } from "@scfloworg/workspace";

export interface AskOptions {
  prompt: string;
  /** Approves every call without asking. */
  yes: boolean;
  maxTurns: number;
  fetch?: AiFetch | undefined;
  /**
   * The skills of the environment. The model is offered those whose `uses`
   * are all actions of the project, listed in the prompt and loaded with
   * `use_skill`; none when left out.
   */
  skills?: SkillCatalogue | undefined;
  out(line: string): void;
  err(line: string): void;
  /** The next line of the standard input, `undefined` at its end. */
  readLine(): Promise<string | undefined>;
}

/** A call made during the run, as `ask` prints it. */
interface AskedCall {
  action: string;
  params: unknown;
  approved: boolean;
  result?: unknown;
  error?: string;
}

export interface AskSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
}

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

const SYSTEM = [
  "You work on an SCFlow project through its actions, which are your tools.",
  "Read the project with the read actions before changing it, and change it only through actions.",
  "When you are done, say in a few sentences what you did.",
].join(" ");

/** The settings of the connection, or the name of the first variable missing. */
export function askSettings(
  env: Readonly<Record<string, string | undefined>>,
): AskSettings | string {
  const apiKey = env.SCFLOW_AI_API_KEY;
  const model = env.SCFLOW_AI_MODEL;
  if (!apiKey) return "SCFLOW_AI_API_KEY";
  if (!model) return "SCFLOW_AI_MODEL";
  return { baseUrl: env.SCFLOW_AI_BASE_URL || DEFAULT_BASE_URL, apiKey, model };
}

/** The system prompt, with the catalogue of the offered skills: their ids and when to use them, never their bodies. */
function systemPrompt(skillTool: SkillTool | null): string {
  if (!skillTool) return SYSTEM;
  return [
    SYSTEM,
    "",
    `Skills are methods for kinds of requests. When one fits the request, call ${SKILL_TOOL} with its id and follow its instructions.`,
    ...skillTool.skills.map((skill) => `- ${skill.id}: ${skill.title}. ${skill.description}`),
  ].join("\n");
}

function describe(call: AiToolCall): string {
  return `${actionIdOfTool(call.name) ?? call.name} ${call.arguments}`;
}

/** Runs the prompt; saves the project if a call changed it. An error of the model is thrown with `code: ai_<kind>`. */
export async function ask(
  doc: Document,
  settings: AskSettings,
  options: AskOptions,
): Promise<void> {
  const actions = doc.dataset.actions().filter((action) => action.exposure !== "hidden");
  const readOnly = new Set(
    actions.filter((action) => action.kind === "read").map((action) => action.id),
  );
  // A skill is offered only with every action of its uses, so it never widens what the model can do.
  const skillTool = options.skills
    ? createSkillTool(options.skills, { actions: actions.map((action) => action.id) })
    : null;
  const client = createAiClient({
    connection: { kind: "byok", ...settings },
    fetch: options.fetch,
    onUsage: (usage) => {
      if (usage.retried) {
        options.err(
          `The model refused ${usage.retried.parameter}; asked again without it: ${usage.retried.message}`,
        );
      }
    },
  });

  const calls = new Map<string, AskedCall>();
  let changed = false;
  let text = "";
  let outcome;
  try {
    outcome = await runAgent({
      client,
      messages: [
        { role: "system", content: systemPrompt(skillTool) },
        { role: "user", content: options.prompt },
      ],
      tools: [...toAiTools(actions), ...(skillTool ? [skillTool.spec] : [])],
      maxTurns: options.maxTurns,
      approve: async (turn) => {
        // Loading a skill reads its body: it needs no approval.
        const writes = turn.filter(
          (call) => call.name !== SKILL_TOOL && !readOnly.has(actionIdOfTool(call.name) ?? ""),
        );
        let approved = options.yes || writes.length === 0;
        if (!approved) {
          options.err(
            `The model asks for ${writes.length} change${writes.length === 1 ? "" : "s"}:`,
          );
          for (const call of writes) options.err(`  ${describe(call)}`);
          options.err("Approve them? [y/N]");
          approved = /^y(es)?$/i.test(((await options.readLine()) ?? "").trim());
        }
        const ids = turn
          .filter((call) => approved || !writes.includes(call))
          .map((call) => call.id);
        for (const call of turn) {
          calls.set(call.id, {
            action: actionIdOfTool(call.name) ?? call.name,
            params: parsed(call.arguments),
            approved: ids.includes(call.id),
          });
        }
        return ids;
      },
      execute: async (call, args) => {
        if (skillTool && call.name === SKILL_TOOL) return skillTool.call(args);
        const outcome = await doc.run(actionIdOfTool(call.name) as string, args);
        changed ||= outcome.changed;
        return outcome.result;
      },
      onEvent: (event) => {
        if (event.type === "text") text += event.text;
        if (event.type === "done" && text) {
          options.err(text);
          text = "";
        }
        if (event.type !== "tool-result") return;
        const entry = calls.get(event.call.id);
        if (!entry) return;
        if (event.error === undefined) entry.result = event.result;
        else entry.error = event.error;
        if (entry.approved)
          options.err(`${event.error === undefined ? "ran" : "failed"}: ${describe(event.call)}`);
      },
    });
  } catch (error) {
    if (error instanceof AiError)
      throw Object.assign(error, { code: `ai_${error.kind.replace(/-/g, "_")}` });
    throw error;
  }

  const written = changed ? (await doc.save()).written : [];
  options.out(
    JSON.stringify({
      text: outcome.text,
      stopped: outcome.stopped,
      turns: outcome.turns,
      calls: [...calls.values()],
      changed,
      written,
    }),
  );
}

function parsed(text: string): unknown {
  try {
    return text.trim() ? JSON.parse(text) : {};
  } catch {
    return text;
  }
}
