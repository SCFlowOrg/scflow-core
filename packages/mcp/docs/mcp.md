# The MCP server

`scflow-mcp` lets an MCP client, such as an AI chat, work on one project on disk through its actions. The client is the AI and handles approval.

```text
scflow-mcp <project> [--modules <folder>]
```

It speaks MCP on the standard input and output. `<project>` is a folder or a `.json` file that exists, and `--modules` is as for the [`scflow` command](../../cli/docs/scflow.md). In code, `createMcpServer({ host, path })` gives a server to connect to any transport.

## Tools

An action is not a tool of its own, because a model has well over 80 actions, and a language model picks worse among that many tools. The actions are reached through a catalogue.

| Tool | Does | Read only |
| --- | --- | --- |
| `list_actions` | The actions of the project: `id`, `title`, `description`, `kind`, `destructive` | Yes |
| `describe_action` | One action `id`, with its `parameters` as JSON Schema | Yes |
| `run_action` | Runs the action `id` with `params` | No |
| `batch` | Runs `commands` in one transaction, each `{ call, with, as }`, with `${name.path}` references to earlier results, and an optional `label` | No |
| `query` | Instances of `schema`, with optional `filters` | Yes |
| `get_languages` | The ordered languages of the project, the first being the source language; `[]` when not stated | Yes |
| `set_languages` | Replaces the `languages`, as one step `undo` can reverse. A duplicate or a bad code is refused with `constraint_violation`. Texts in other languages are kept | No |
| `search_docs` | The documentation topics of the installed modules that match `query`: `id`, `title`, `summary`, `kind`, `audience`, `snippet`; never the body. Takes an optional `audience` (one or a list, `user` by default), `locale` and `limit` | Yes |
| `read_docs` | The topic `topicId` as `{ topic, content }`, `content` being Markdown. Takes `audience` and `locale` as `search_docs` does. A topic outside the audience is `not_found` | Yes |
| `undo`, `redo` | Moves through the history of this server | No |

`describe_action` names the languages of the project, and its source language, in the description of each localized text parameter (see `toAiTools` in `@scfloworg/actions`).

An action whose `exposure` is `hidden` is absent from `list_actions`, and calling it is refused with `unknown_action`, in a batch as well.

## Prompts

The server declares the `prompts` capability and exports each skill of its environment as an MCP prompt, as it exports the actions as tools, so any MCP client finds the methods of the modules. A skill is offered only when it is visible and every action of its `uses` is a visible action of the project, as `createSkillTool` of `@scfloworg/environment` decides; only the skills of the modules installed by `--modules` are offered, never those that come only with the project.

| Request | Gives |
| --- | --- |
| `prompts/list` | One prompt per offered skill: `name` is the skill id, such as `scflow/image_to_model`, with its `title` and `description` |
| `prompts/get` | The `description` of the skill and one `user` message whose text is the Markdown body of the skill. A name that is not an offered skill is an `InvalidParams` error |

A prompt takes no arguments: the body is a method the client follows with the tools above.

## Documentation

The topics of the installed modules (see [`@scfloworg/docs`](../../docs/docs/docs.md), and Documentation in the [environment](../../environment/docs/environment.md#documentation)) are reached through `search_docs` and `read_docs`, built with `createDocsTool` over a catalogue of `env.docs`. The caller gives the audience, so an AI that helps a user is never shown a topic for model developers; the default is `user`. A module that comes only with the project gives no topic, as for skills. Skills stay prompts: a skill is not a topic.

The server also declares the `resources` capability and lists each topic for the `user` audience, in the default locale, as a `text/markdown` resource with the URI `docs://<id>`, such as `docs://scflow/undo`. A client that wants another audience or locale uses the tools. Reading a URI of an unknown topic or of another audience is an `InvalidParams` error.

## Saving

Each change that succeeds is saved at once: an AI client has no notion of saving, and the project must be right when the chat ends. A tool that changes nothing writes nothing.

## Errors

A refusal is a tool result with `isError` and the text `{ "error": { "code", "message" } }`, so an AI can act on it.

## A change made on disk meanwhile

When another tool changed the project, the save is refused with `project_changed_on_disk`. The server then drops what it holds, its history included, and reads the project again, so the change that was refused is not applied. The client can simply call again.

A read made after such a change sees the old state until the next write, because the project is only read again when a save is refused.
