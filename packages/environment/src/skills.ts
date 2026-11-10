/**
 * The skills of an environment: the catalogue of the skills of its installed
 * modules, the `use_skill` tool an AI host offers, and the check of the action
 * ids a body cites (see `docs/environment.md`, Skills, and Skill in
 * `packages/core/docs/spec/meta-model.md`).
 */
import { modelError } from "@scfloworg/core";
import { actionError } from "@scfloworg/actions";
import type { ModuleCatalogue } from "./catalogue.js";

/** A skill of the catalogue: what enters a prompt, never its body. */
export interface SkillEntry {
  /** The qualified id, the namespace of its module, a slash and a name. */
  readonly id: string;
  /** The key of the module that declares it. */
  readonly module: string;
  readonly title: string;
  /** When to use the skill. */
  readonly description: string;
  /** The ids of the actions the skill relies on. */
  readonly uses: readonly string[];
  readonly exposure: "visible" | "hidden";
}

/** A skill loaded for a model: the result of `use_skill`. */
export interface SkillContent {
  readonly skillId: string;
  readonly title: string;
  /** The Markdown body of the skill. */
  readonly instructions: string;
}

/** `env.skills`: the skills of the installed modules. */
export interface SkillCatalogue {
  /**
   * The skills of the installed modules, in the order of the modules, then of
   * their manifests. A module that comes only embedded in a dataset is not
   * installed, and its skills are never listed.
   */
  list(): readonly SkillEntry[];
  /** The skill of `id`, or `undefined`. */
  get(id: string): SkillEntry | undefined;
  /** Reads the body of the skill `id`. Fails with `key_not_found` for an id the catalogue does not hold. */
  load(id: string): Promise<SkillContent>;
}

export function createSkillCatalogue(modules: ModuleCatalogue): SkillCatalogue {
  const entries = (): SkillEntry[] =>
    modules.list().flatMap((installed) =>
      (installed.manifest.skills ?? []).map((skill) =>
        Object.freeze({
          id: skill.id,
          module: installed.key,
          title: skill.title,
          description: skill.description,
          uses: Object.freeze([...skill.uses]),
          exposure: skill.exposure,
        }),
      ),
    );
  const get = (id: string) => entries().find((entry) => entry.id === id);
  return {
    list: entries,
    get,
    async load(id) {
      const entry = get(id);
      const loader = entry && modules.get(entry.module)?.skills.get(id);
      if (!entry || !loader) throw modelError("key_not_found", `no installed module offers the skill "${id}"`);
      return { skillId: id, title: entry.title, instructions: await loader() };
    },
  };
}

/** The name of the tool that loads a skill. */
export const SKILL_TOOL = "use_skill";

/**
 * The definition of `use_skill`, shaped as an `AiToolSpec` of
 * `@scfloworg/ai`, which knows nothing of skills.
 */
export interface SkillToolSpec {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  /** The parameters, a JSON Schema object: `skillId`, one of the offered ids. */
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly annotations: { readonly title: string; readonly readOnlyHint: true };
}

/** `use_skill` for one assistant: its definition, the skills it offers and its call. */
export interface SkillTool {
  readonly spec: SkillToolSpec;
  /** The skills offered, for a host that lists them in its prompt. */
  readonly skills: readonly SkillEntry[];
  /** Loads an offered skill. Fails with `invalid_parameters` for an input that names no offered skill. */
  call(input: unknown): Promise<SkillContent>;
}

/** What `createSkillTool` takes. */
export interface SkillToolOptions {
  /** The actions the assistant offers: their ids, or a test on an id. */
  readonly actions: Iterable<string> | ((id: string) => boolean);
}

/**
 * Builds `use_skill` from `catalogue` for an assistant that offers
 * `options.actions`. A skill is offered only when it is `visible` and every
 * action of its `uses` is offered, so a skill never widens what an assistant
 * can do. Returns `null` when no skill is offered: the assistant then needs no
 * tool.
 */
export function createSkillTool(catalogue: SkillCatalogue, options: SkillToolOptions): SkillTool | null {
  const offered =
    typeof options.actions === "function" ? options.actions : ((ids) => (id: string) => ids.has(id))(new Set(options.actions));
  const skills = catalogue.list().filter((skill) => skill.exposure === "visible" && skill.uses.every((id) => offered(id)));
  if (skills.length === 0) return null;
  const ids = new Set(skills.map((skill) => skill.id));
  const description = [
    "Loads the instructions of a skill, a method for a kind of request. Call it with the skillId of a relevant skill before doing the task.",
    "A skill never adds a tool or an action, and never bypasses an approval.",
    "Skills:",
    ...skills.map((skill) => `- ${skill.id}: ${skill.title}. ${skill.description}`),
  ].join("\n");
  return {
    spec: {
      name: SKILL_TOOL,
      title: "Use a skill",
      description,
      inputSchema: {
        type: "object",
        properties: {
          skillId: { type: "string", enum: [...ids], description: "the id of the skill to load" },
        },
        required: ["skillId"],
        additionalProperties: false,
      },
      annotations: { title: "Use a skill", readOnlyHint: true },
    },
    skills,
    async call(input) {
      const skillId = (input as { skillId?: unknown } | null)?.skillId;
      if (typeof skillId !== "string" || !ids.has(skillId))
        throw actionError("invalid_parameters", `${JSON.stringify(skillId)} is not a skill offered here`);
      return catalogue.load(skillId);
    },
  };
}

const ACTION_ID = /^[A-Za-z_][A-Za-z0-9_]*\/[A-Za-z_][A-Za-z0-9_]*$/;

/** The action ids a Markdown body cites: each code span in backticks that is an action id, once, in order. */
export function citedActionIds(body: string): string[] {
  const cited = new Set<string>();
  for (const match of body.matchAll(/`([^`\n]+)`/g)) {
    const text = match[1].trim();
    if (ACTION_ID.test(text)) cited.add(text);
  }
  return [...cited];
}

/** An action id a skill body cites although its `uses` does not name it. */
export interface SkillCitationFinding {
  readonly skill: string;
  readonly action: string;
}

/**
 * The test of a module's skills: loads the body of each skill of `catalogue`,
 * or of the skills of `ids`, and returns each cited action id that is not in
 * the `uses` of its skill. An empty list means every citation is declared.
 */
export async function checkSkillCitations(
  catalogue: SkillCatalogue,
  ids: readonly string[] = catalogue.list().map((skill) => skill.id),
): Promise<SkillCitationFinding[]> {
  const findings: SkillCitationFinding[] = [];
  for (const id of ids) {
    const entry = catalogue.get(id);
    if (!entry) throw modelError("key_not_found", `no installed module offers the skill "${id}"`);
    const { instructions } = await catalogue.load(id);
    for (const action of citedActionIds(instructions))
      if (!entry.uses.includes(action)) findings.push({ skill: id, action });
  }
  return findings;
}
