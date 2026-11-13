import { loadInstance, type Instance } from "./refs.js";
import { cascadeParam, type ScflowActionDefinition, localizedTextParam, refParam } from "./params.js";
import { localizedText } from "./text.js";

/** Parameters of `scflow/add_note`. */
export interface AddNoteParams {
  annotated: string;
  content: string | Record<string, string>;
}

/** Parameters of `scflow/update_note`. */
export interface UpdateNoteParams {
  id: string;
  content: string | Record<string, string>;
}

/** Parameters of `scflow/remove_note`. */
export interface RemoveNoteParams {
  id: string;
  cascade?: boolean;
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

/** Adds a note to an entity; see `scflow/add_note` in the topic `scflow/actions`. */
export const addNoteAction: ScflowActionDefinition<AddNoteParams, NoteSummary> = {
  id: "scflow/add_note",
  writes: ["note"],
  title: "Add a note",
  description:
    "Adds a Markdown note to an entity of the model (actor, flow, item, scope, type, transformation...) and returns it. " +
    "The entity is given by its id. A plain string is stored as English text; give a map of language to string for other languages.",
  parameters: {
    type: "object",
    properties: {
      annotated: refParam("annotable", "Id of the entity to annotate, whatever its kind."),
      content: localizedTextParam("Markdown text of the note."),
    },
    required: ["annotated", "content"],
    additionalProperties: false,
  },
  async run(params, context) {
    const content = await localizedText(context, params.content);

    const { after } = await context.runCommand(context.locator, {
      kind: "create",
      schema: "scflow.note",
      input: { annotated: params.annotated, content },
    });
    return summarizeNote(after[0] as unknown as Instance);
  },
};

/** Changes the content of a note; see `scflow/update_note` in the topic `scflow/actions`. */
export const updateNoteAction: ScflowActionDefinition<UpdateNoteParams, NoteSummary> = {
  id: "scflow/update_note",
  writes: ["note"],
  title: "Update a note",
  description:
    "Changes the content of a note and returns it. Each given language replaces the text of the same language, the other languages are kept. " +
    "The note stays on its entity.",
  parameters: {
    type: "object",
    properties: {
      id: refParam("note", "Id of the note to update."),
      content: localizedTextParam("New Markdown text; each given language replaces the same language."),
    },
    required: ["id", "content"],
    additionalProperties: false,
  },
  async run(params, context) {
    const content = await localizedText(context, params.content);

    const { after } = await context.runCommand(context.locator, {
      kind: "update",
      schema: "scflow.note",
      filters: { id: params.id },
      input: { content: { set: content } },
    });
    return summarizeNote(after[0] as unknown as Instance);
  },
};

/** Deletes a note; see `scflow/remove_note` in the topic `scflow/actions`. */
export const removeNoteAction: ScflowActionDefinition<RemoveNoteParams, { id: string }> = {
  id: "scflow/remove_note",
  writes: ["note"],
  destructive: true,
  title: "Remove a note",
  description: "Deletes a note and returns its id. The entity it annotated is not changed. The cascade parameter is accepted for consistency with the other delete actions and changes nothing.",
  parameters: {
    type: "object",
    properties: {
      id: refParam("note", "Id of the note to delete."),
      cascade: cascadeParam("Has no effect: nothing depends on a note."),
    },
    required: ["id"],
    additionalProperties: false,
  },
  async run(params, context) {
    await context.runCommand(context.locator, { kind: "delete", schema: "scflow.note", filters: { id: params.id } });
    return { id: params.id };
  },
};

/** Lists the notes of an entity; see `scflow/find_notes` in the topic `scflow/actions`. */
export const findNotesAction: ScflowActionDefinition<FindNotesParams, NoteSummary[]> = {
  id: "scflow/find_notes",
  writes: [],
  title: "Find the notes of an entity",
  description:
    "Lists the notes of an entity, given by its id: [{ id, entity, content }]. An entity without a note gives an empty list. It changes nothing.",
  kind: "read",
  parameters: {
    type: "object",
    properties: {
      entity: refParam("annotable", "Id of the entity, whatever its kind."),
    },
    required: ["entity"],
    additionalProperties: false,
  },
  async run(params, context) {
    const { after } = await context.runCommand(context.locator, {
      kind: "query",
      schema: "scflow.note",
      filters: { annotated: params.entity },
    });
    return (after as unknown as Instance[]).map(summarizeNote);
  },
};

/** The actions of the lot notes, in catalog order. */
export const NOTE_ACTIONS = [addNoteAction, updateNoteAction, removeNoteAction, findNotesAction] as const;
