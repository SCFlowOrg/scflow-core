# The MCP server

`scflow-mcp` lets an MCP client, such as an AI chat, work on one project on disk through its actions. The client is the AI and handles approval.

```text
scflow-mcp <project> [--modules <folder>]
```

It speaks MCP on the standard input and output. `<project>` is a folder or a `.json` file that exists, and `--modules` is as for the [`scflow` command](../../repl/docs/scflow.md). In code, `createMcpServer({ host, path })` gives a server to connect to any transport.

## Tools

An action is not a tool of its own, because a model has well over 80 actions, and a language model picks worse among that many tools. The actions are reached through a catalogue.

| Tool | Does | Read only |
| --- | --- | --- |
| `list_actions` | The actions of the project: `id`, `title`, `description`, `kind`, `destructive` | Yes |
| `describe_action` | One action `id`, with its `parameters` as JSON Schema | Yes |
| `run_action` | Runs the action `id` with `params` | No |
| `batch` | Runs `commands` in one transaction, each `{ call, with, as }`, with `${name.path}` references to earlier results, and an optional `label` | No |
| `query` | Instances of `schema`, with optional `filters` | Yes |
| `undo`, `redo` | Moves through the history of this server | No |

An action whose `exposure` is `hidden` is absent from `list_actions`, and calling it is refused with `unknown_action`, in a batch as well.

## Saving

Each change that succeeds is saved at once: an AI client has no notion of saving, and the project must be right when the chat ends. A tool that changes nothing writes nothing.

## Errors

A refusal is a tool result with `isError` and the text `{ "error": { "code", "message" } }`, so an AI can act on it.

## A change made on disk meanwhile

When another tool changed the project, the save is refused with `project_changed_on_disk`. The server then drops what it holds, its history included, and reads the project again, so the change that was refused is not applied. The client can simply call again.

A read made after such a change sees the old state until the next write, because the project is only read again when a save is refused.
