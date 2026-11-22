# The `scflow` command

`scflow` works on a project on disk, through actions. `model-repl` stays beside it for the command language and the fixtures of `repl-conformance`: its low-level commands reach only datasets that are not projects.

```text
scflow <project> create --type <publisher:type> --title <title> --module <key>... [--language <code>]... [--modules <folder>]
scflow <project> languages [<codes as JSON array>] [--modules <folder>]
scflow <project> actions [--modules <folder>]
scflow <project> run <action> [<parameters as JSON>] [--modules <folder>]
scflow <project> query <schema> [<filters as JSON>] [--modules <folder>]
scflow <project> export <folder> [--schema <name>]... [--separator <c>] [--list-separator <s>] [--modules <folder>]
scflow <project> import <folder|file.csv>... [--dry-run] [--separator <c>] [--list-separator <s>] [--modules <folder>]
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
| `export` | Writes the project to CSV files, one per sheet, in a folder. It writes nothing in the project. See [CSV files](#csv-files) |
| `import` | Creates and updates the entities the CSV files hold, as one undoable step, and saves the project. See [CSV files](#csv-files) |
| `shell` | Reads commands from the standard input, one per line |
| `ask` | Runs a prompt with a language model that works on the project through its actions, and saves the project if they changed it |

`actions`, `query` and `export` open the project read only, so they upgrade nothing.

## Output

Each command prints one JSON document on the standard output: for `run`, `{ result, changed, written }`, where `written` lists the files the save changed. `written` is empty when nothing changed, and the bytes on disk stay the same.

A refusal prints `{ "error": { "code", "message" } }` on the standard error and exits with `1`, with nothing saved. A wrong command line exits with `2`.

## The shell

`run <action> [<JSON>]`, `query <schema> [<JSON>]`, `actions`, `export <folder> [options]`, `import <folder|file.csv>... [options]`, `undo`, `redo`, `history`, `save` and `exit`. A refusal is printed and the shell goes on.

In the shell, `export` and `import` take the same options as the command, written after their arguments, and the paths hold no space. An `import` is one undo step, labelled `Import sheets`, and it does not save either.

Undo lives in memory, so it exists only in the shell. In the shell, `run` does not save: `save` does, and the end of the input without a `save` loses the changes, which the shell says.

## CSV files

`export` and `import` put a project in files and read it back. The rows come from [`@scfloworg/spreadsheet`](../../spreadsheet/docs/spreadsheet.md), which says which entities have a sheet, which columns it has, how a reference is written and what an import does with a row; this section says only what the command adds: the files.

### Export

`export <folder>` writes one file per sheet in the folder, which it creates if need be, named after the sheet, `actor.csv`, `flow.csv`, and replaces a file of the same name. `--schema <name>` (repeatable, a short or a qualified name) keeps only those sheets; an unknown name is a refusal (`unknown_sheet`) and nothing is written. It prints `{ files, skipped }`: `files` lists the names of the files written, `skipped` what the sheets leave out, with the reason. Two exports of one project are the same files.

### Import

`import` takes files, or folders, which stand for the `.csv` files they hold, by name. The sheet of a file is its name without `.csv`: `actor.csv` is the sheet `actor`, `scflow.actor.csv` the sheet `scflow.actor`. Two files for one sheet are a refusal (`duplicate_sheet`).

- The whole import is one transaction of the project and one undo step. Rows are written by the actions of the model, and its rules are checked at the end.
- `--dry-run` runs it all, then rolls back: nothing is written, and the report still says what the rules of the model refuse.
- The project is saved only when the report is `ok` and the import is not a dry run. An import never deletes.
- It prints the `ImportReport` of the package as one JSON document, with `written` as the other commands have it: `{ ok, dryRun, applied, created, updated, unchanged, refused, rows, errors, order, written }`. `line` of a row is the number of its record in the file, the header being line 1.
- To build a project from a spreadsheet: `scflow <project> create ...`, then `scflow <project> import <folder>`. Create the project with the languages and modules of the files.

### The files

- UTF-8, one header line with the columns of the sheet (`name`, `name (fr)`, `carbon.co2`), then one record per row. A leading byte order mark is accepted on read, and never written.
- Cells are text. An empty cell is an empty field. A number or a boolean is written `12.5`, `true`, and read back by the import, which converts it to the type of its property. A list is one cell, its values joined by `;` and a space, or by `--list-separator`; a value that holds the list separator fails the export (`separator_in_value`).
- Columns are separated by a comma, or by `--separator <c>`, one character, which is neither a quote nor a line break: `--separator ';'` for a spreadsheet in French, `--separator '	'` for a tab. A field that holds the separator, a quote or a line break is quoted, the quotes doubled (RFC 4180); line breaks inside a field are kept. Lines end with LF when written; LF, CRLF and CR are read.
- A record shorter than the header leaves its last cells empty. A record with a value beyond the header, a quote that never closes, and a file with no header are refused (`invalid_csv`).

### Refusals

- A refused import (a row refused, a rule of the model broken) prints its report on the standard output, since the report is the result, exits with `1` and saves nothing: every row is listed with its status and its reason.
- A refusal that is not about the rows prints `{ "error": { "code", "message" } }` on the standard error, exits with `1` and saves nothing: `file_unreadable`, `invalid_csv`, `duplicate_sheet`, `unknown_sheet` (a file named after no sheet), `separator_in_value`.
- A wrong command line exits with `2`: no folder or file, a folder that holds no `.csv` file, a separator that is not one character.

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
