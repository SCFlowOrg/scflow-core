# The `scflow` command

`scflow` works on a project on disk, through actions. `model-repl` stays beside it for the command language and the fixtures of `repl-conformance`: its low-level commands reach only datasets that are not projects.

```text
scflow <project> create --type <publisher:type> --title <title> --module <key>... [--modules <folder>]
scflow <project> actions [--modules <folder>]
scflow <project> run <action> [<parameters as JSON>] [--modules <folder>]
scflow <project> query <schema> [<filters as JSON>] [--modules <folder>]
scflow <project> shell [--modules <folder>]
```

`<project>` is a folder or a `.json` file. `--modules` names a folder of modules: the folder of one module, or a folder whose sub-folders each hold one, recognized by their `module.yaml`. A module the project embeds and the folder does not hold opens the project read only.

| Command | Does |
| --- | --- |
| `create` | Creates and saves a project that uses the modules `--module` names, with their dependencies. Refused if a project is already there |
| `actions` | Lists the actions the project can run |
| `run` | Runs one action, and saves the project if the action changed it |
| `query` | Runs a query of a schema, with no action. It writes nothing |
| `shell` | Reads commands from the standard input, one per line |

`actions` and `query` open the project read only, so they upgrade nothing.

## Output

Each command prints one JSON document on the standard output: for `run`, `{ result, changed, written }`, where `written` lists the files the save changed. `written` is empty when nothing changed, and the bytes on disk stay the same.

A refusal prints `{ "error": { "code", "message" } }` on the standard error and exits with `1`, with nothing saved. A wrong command line exits with `2`.

## The shell

`run <action> [<JSON>]`, `query <schema> [<JSON>]`, `actions`, `undo`, `redo`, `history`, `save` and `exit`. A refusal is printed and the shell goes on.

Undo lives in memory, so it exists only in the shell. In the shell, `run` does not save: `save` does, and the end of the input without a `save` loses the changes, which the shell says.
