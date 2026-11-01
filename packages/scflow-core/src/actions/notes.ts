import type { ModelActionDefinition } from "@scfloworg/core";
import { localizedTextParam, refParam } from "./params.js";
import { resolveEntity, resolveRef, type Instance } from "./refs.js";
import { toLocalized } from "./text.js";

/** Parameters of `scflow/add_note`. */
export interface AddNoteParams {
  entity: string;
  content: string | Record<string, string>;
}

/** Parameters of `scflow/update_note`. */
export interface UpdateNoteParams {
  note: string;
  content: string | Record<string, string>;
}

/** Parameters of `scflow/remove_note`. */
export interface RemoveNoteParams {
  note: string;
}

/** Parameters of `scflow/find_notes`. */
export interface FindNotesParams {
  entity: string;
}

/** A note as the note actions return it. */
export interface NoteSummary {
  id: string;
  entity: string;
  content: Record<string, string>;
}

/** The summary of a note instance. */
function summarizeNote(note: Instance): NoteSummary {
  return { id: note.id, entity: note.annotated as string, content: note.content as Record<string, string> };
}

/** Adds a note to an entity; see `scflow/add_note` in `docs/actions.md`. */
export const addNoteAction: ModelActionDefinition<AddNoteParams, NoteSummary> = {
  id: "scflow/add_note",
  title: "Add a note",
  description:
    "Adds a Markdown note to an entity of the model (actor, flow, item, scope, type, transformation...) and returns it. " +
    "The entity is given by its id. A plain string is stored as English text; give a map of language to string for other languages.",
  parameters: {
    type: "object",
    properties: {
      entity: refParam("Id of the entity to annotate, whatever its kind."),
      content: localizedTextParam("Markdown text of the note."),
    },
    required: ["entity", "content"],
    additionalProperties: false,
  },
  async execute(access, locator, params) {
    const entity = await resolveEntity(access, locator, params.entity, "entity");
    const content = toLocalized(params.content, "content");

    const { after } = await access.runCommand(locator, {
      kind: "create",
      schema: "note",
      input: { annotated: entity.id, content },
    });
    return summarizeNote(after[0] as unknown as Instance);
  },
};

/** Changes the content of a note; see `scflow/update_note` in `docs/actions.md`. */
export const updateNoteAction: ModelActionDefinition<UpdateNoteParams, NoteSummary> = {
  id: "scflow/update_note",
  title: "Update a note",
  description:
    "Changes the content of a note and returns it. Each given language replaces the text of the same language, the other languages are kept. " +
    "The note stays on its entity.",
  parameters: {
    type: "object",
    properties: {
      note: refParam("Id of the note to update."),
      content: localizedTextParam("New Markdown text; each given language replaces the same language."),
    },
    required: ["note", "content"],
    additionalProperties: false,
  },
  async execute(access, locator, params) {
    const note = await resolveRef(access, locator, "note", params.note, "note");
    const content = toLocalized(params.content, "content");

    const { after } = await access.runCommand(locator, {
      kind: "update",
      schema: "note",
      filters: { id: note.id },
      input: { content: { set: content } },
    });
    return summarizeNote(after[0] as unknown as Instance);
  },
};

/** Deletes a note; see `scflow/remove_note` in `docs/actions.md`. */
export const removeNoteAction: ModelActionDefinition<RemoveNoteParams, { id: string }> = {
  id: "scflow/remove_note",
  title: "Remove a note",
  description: "Deletes a note and returns its id. The entity it annotated is not changed.",
  parameters: {
    type: "object",
    properties: {
      note: refParam("Id of the note to delete."),
    },
    required: ["note"],
    additionalProperties: false,
  },
  async execute(access, locator, params) {
    const note = await resolveRef(access, locator, "note", params.note, "note");
    await access.runCommand(locator, { kind: "delete", schema: "note", filters: { id: note.id } });
    return { id: note.id };
  },
};

/** Lists the notes of an entity; see `scflow/find_notes` in `docs/actions.md`. */
export const findNotesAction: ModelActionDefinition<FindNotesParams, NoteSummary[]> = {
  id: "scflow/find_notes",
  title: "Find the notes of an entity",
  description:
    "Lists the notes of an entity, given by its id: [{ id, entity, content }]. An entity without a note gives an empty list. It changes nothing.",
  kind: "read",
  parameters: {
    type: "object",
    properties: {
      entity: refParam("Id of the entity, whatever its kind."),
    },
    required: ["entity"],
    additionalProperties: false,
  },
  async execute(access, locator, params) {
    const entity = await resolveEntity(access, locator, params.entity, "entity");
    const { after } = await access.runCommand(locator, {
      kind: "query",
      schema: "note",
      filters: { annotated: entity.id },
    });
    return (after as unknown as Instance[]).map(summarizeNote);
  },
};

/** The actions of the lot notes, in catalog order. */
export const NOTE_ACTIONS = [addNoteAction, updateNoteAction, removeNoteAction, findNotesAction] as const;
