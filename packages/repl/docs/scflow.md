# The `scflow` command

`scflow` works on a project on disk, through actions. `model-repl` stays beside it for the command language and the fixtures of `repl-conformance`: its low-level commands reach only datasets that are not projects.

```text
scflow <project> create --type <publisher:type> --title <title> --module <key>... [--language <code>]... [--modules <folder>]
scflow <project> languages [<codes as JSON array>] [--modules <folder>]
scflow <project> actions [--modules <folder>]
scflow <project> run <action> [<parameters as JSON>] [--modules <folder>]
scflow <project> query <schema> [<filters as JSON>] [--modules <folder>]
scflow <project> shell [--modules <folder>]
scflow <project> ask <prompt> [--yes] [--max-turns <n>] [--modules <folder>]
```

`<project>` is a folder or a `.json` file. `--modules` names a folder of modules: the folder of one module, or a folder whose sub-folders each hold one, recognized by their `module.yaml`. A module the project embeds and the folder does not hold opens the project read only.

| Command | Does |
| --- | --- |
| `create` | Creates and saves a project that uses the modules `--module` names, with their dependencies. Refused if a project is already there |
| `languages` | Without an argument, prints `{ languages }`, the ordered languages of the project (`[]` when not stated). With a JSON array of language codes, replaces them as one undoable step, saves, and prints `{ languages, changed, written }`. The first is the source language. `create --language` (repeatable) seeds them |
| `actions` | Lists the actions the project can run |
| `run` | Runs one action, and saves the project if the action changed it |
| `query` | Runs a query of a schema, with no action. It writes nothing |
| `shell` | Reads commands from the standard input, one per line |
| `ask` | Runs a prompt with a language model that works on the project through its actions, and saves the project if they changed it |

`actions` and `query` open the project read only, so they upgrade nothing.

## Output

Each command prints one JSON document on the standard output: for `run`, `{ result, changed, written }`, where `written` lists the files the save changed. `written` is empty when nothing changed, and the bytes on disk stay the same.

A refusal prints `{ "error": { "code", "message" } }` on the standard error and exits with `1`, with nothing saved. A wrong command line exits with `2`.

## The shell

`run <action> [<JSON>]`, `query <schema> [<JSON>]`, `actions`, `undo`, `redo`, `history`, `save` and `exit`. A refusal is printed and the shell goes on.

Undo lives in memory, so it exists only in the shell. In the shell, `run` does not save: `save` does, and the end of the input without a `save` loses the changes, which the shell says.

## Asking a model

`ask` tells the model the languages of the project and its source language, in its instructions and in the description of each localized text parameter, so it writes only in them.

`ask` gives the prompt to a language model, with the visible actions of the project as its tools, through the agent loop of `@scfloworg/ai`. The model reads and changes the project only through actions.

The connection comes from the environment; nothing is stored:

| Variable | Is |
| --- | --- |
| `SCFLOW_AI_BASE_URL` | The base URL of an OpenAI-compatible API; `https://api.openai.com/v1` when unset |
| `SCFLOW_AI_API_KEY` | The key, required |
| `SCFLOW_AI_MODEL` | The model, required |

A missing key or model is a wrong command line.

### Skills

The skills of the modules installed by `--modules` reach the model as the [environment](../../environment/docs/environment.md#skills) offers them: a skill is offered only when it is visible and every action of its `uses` is a visible action of the project, so a skill never gives the model an action it would not have. When a skill is offered, the system prompt lists the catalogue, each skill by its id, title and description, and the model has one more tool, `use_skill`, built by `createSkillTool` of `@scfloworg/environment`. The body of a skill never enters the prompt: the model calls `use_skill` with a `skillId` of the catalogue and gets `{ skillId, title, instructions }` back. Loading a skill reads nothing of the project and asks no approval; it appears in `calls` with the action `use_skill`. When no skill is offered there is no `use_skill` tool and the prompt names none.

Each answer of the model may ask for several calls. The calls of read actions run at once. The calls of the other actions of one answer are listed on the standard error, and one question approves or refuses them together: `y` or `yes` on the standard input approves them, anything else, or the end of the input, refuses them, and the model is told so. `--yes` approves every call without asking; it is off by default. `--max-turns` bounds the number of answers, `10` by default.

The text of the model and each call are shown on the standard error as they come. At the end `ask` saves the project if a call changed it, and prints `{ text, stopped, turns, calls, changed, written }`: `text` is the last answer, `stopped` is `done` or `turn-limit`, and `calls` lists each call with its `action`, `params`, `approved`, and its `result` or `error`. An error of the model (`auth`, `rate-limit`, `model-not-found`, …) is a refusal: it prints `{ "error": { "code": "ai_<kind>", "message" } }`, exits with `1`, and saves nothing.

## Documentation

`scflow docs` reads the documentation topics of the modules installed by `--modules`, with no project (see [`@scfloworg/docs`](../../docs/docs/docs.md) and Documentation in the [environment](../../environment/docs/environment.md#documentation)). Skills are not topics and keep `ask`.

```text
scflow docs list [--audience <audience>]... [--locale <code>] [--modules <folder>]
scflow docs check [--modules <folder>]
scflow docs build <directory> [--audience <audience>]... [--modules <folder>]
scflow docs show <id> [--audience <audience>]... [--locale <code>] [--modules <folder>]
```

`--audience` is `user`, `plugin-dev` or `model-dev`, repeated for several, and every audience when left out. `docs` followed by one of these four words is always this command; a project folder named `docs` is reached with a path such as `./docs`.

- `list` prints a JSON array of `{ id, title, summary, kind, audience, locale }`, one topic per id in the locale asked, else the default one.
- `show` prints `{ topic, content }`, the body being Markdown. An unknown topic, or one outside the audiences, fails with `not_found`.
- `check` runs `check()` of the catalogue and prints `{ ok, topics, problems }`. It exits with `1` when `ok` is false, and writes one line `<topic id>: <message>` to the standard error for each problem, so the owner of a defect is named: a duplicate id, an unresolved `[[id]]` link, an unreadable body.
- `build` writes `docs-manifest.json` (see `DOCS_MANIFEST_FILE`) and the body of every topic and locale, at `<directory>/<locale>/<id>.md`, and prints `{ topics, manifest, written }`. The site and the framework bundle read this directory. `--audience` keeps only those audiences in both.
