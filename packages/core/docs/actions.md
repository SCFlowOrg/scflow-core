# Model actions

A model action is a named operation on a dataset, described well enough for a
UI or an AI assistant to list it, ask for its parameters and run it. A domain
package declares its actions; a host registers and runs them.

`@scfloworg/core` defines the contract as types only: `ModelActionDefinition`
and `ModelActionParamsSchema`. It registers and runs nothing.

```ts
import type { MclAccess, ModelActionDefinition } from "@scfloworg/core";

export const addTask: ModelActionDefinition<{ title: string }, string> = {
  id: "tasks/add_task",
  title: "Add a task",
  description: "Creates a task with the given title and returns its id.",
  parameters: {
    type: "object",
    properties: { title: { type: "string", description: "Title of the task" } },
    required: ["title"],
    additionalProperties: false,
  },
  async execute(access: MclAccess, locator: string, params) {
    const { after } = await access.runCommand(locator, {
      kind: "create",
      schema: "task",
      input: { title: params.title },
    });
    return String((after[0] as { id: unknown }).id);
  },
};
```

## Fields

- `id` is unique and scoped by the name of the package that declares it
  (`tasks/add_task`).
- `title` is the label shown to a user and in the undo history.
- `description` states what the action does and when to use it; an AI assistant
  chooses an action from it.
- `parameters` is a JSON Schema (Draft-07) of type `object`, typed by
  `ModelActionParamsSchema`. The engine does not validate parameters against it.
- `kind` is `"action"` (the default) for an action that changes the dataset, or
  `"read"` for one that only queries or inspects it. A host runs an `"action"`
  inside an undo transaction and a `"read"` outside any.
- `execute(access, locator, params)` runs the action on the dataset designated
  by `locator`.

## Writing `execute`

- The action reaches the dataset only through the `MclAccess` it receives, so it
  runs against any implementation and is tested without a shell (see
  [sessions.md](sessions.md)).
- The action may chain several commands. It opens no transaction: the host runs
  it inside one, so the commands form one atomic, undoable step.
- The action imports types from `@scfloworg/core`, never a value.
- A failure is an exception; the host's transaction discards what the action had
  already written.
- A `"read"` action writes nothing: the host opens no transaction for it, so a
  command that changed the dataset would not be undoable and would not roll back.
