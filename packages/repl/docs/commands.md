# Commands and contexts

## Input

Every line is a meta-command, dispatched on Enter with no marker character. `run` is the only way to enter YAML: the next lines, up to a blank line or the end of input, are parsed as one command and executed, and the prompt returns to meta-command mode. A command is `kind` (`query`, `create`, `update` or `delete`), `schema`, and optionally `filters`, `input` (an array) and `as`; the sugar `query: <schema>` (or `create:`, `update:`, `delete:`) names kind and schema in one key. A failed command prints its error and the session stays live; commands already executed are not rolled back.

A successful command prints a one-line summary of the entry counts of its result. The full result is held in variables, see below.

A meta-command name may be abbreviated to any unambiguous prefix (`r` for `run`, `h` for `help`, `sh` for `show`). A prefix matching several names is reported as ambiguous with its candidates. Arguments are split on whitespace, with double quotes grouping an argument that holds spaces. `open`, `use` and `upgrade` take the whole rest of the line, so they need no quotes.

## Dataset contexts

A session holds any number of open datasets, each under its own `name`, and one is current. A command block runs against the current dataset.

| Command | Effect |
| --- | --- |
| `new <locator> <name>` | Creates a dataset and opens it under `<name>` |
| `open <locator>` | Opens an existing dataset under its own stored name |
| `upload <locator> <file> [json\|yaml]` | Creates a dataset from a `dump` snapshot (default `yaml`) and opens it under the dump's own name; fails with `dataset_already_exists` when the locator holds a dataset |
| `use <name>` | Switches the current dataset |
| `datasets` | Lists the open datasets, the current one, and what each upgrade belongs to |

- The first dataset opened in a session becomes current; a later one becomes current only through `use`.
- Opening under a name already in use overwrites that entry and prints a warning. The dataset at the overwritten locator is untouched.
- The schemas and scalar types of a locator load once per process, on its first open, and are shared by every context opened on that locator. A model change made by another process is not seen until a new REPL process opens the locator; a `commit` from this REPL refreshes it.
- Result variables are scoped per context, since a key is only meaningful within its own dataset.

## Variables and snippets

Two mechanisms with different syntaxes.

**Result variables** are data references to what a command produced, resolved after the command runs with the placeholder syntax `${name.after.0.id}`, dot paths only. An omitted array index means `0`, so `${r.after.name}` equals `${r.after.0.name}`. `*` maps the rest of the path over every entry: `${n1.after.*.id}` is an array of ids. Every command also stores its result in `r`, the previous command's result, in addition to the `as` name it carries.

**Snippets** are named chunks of raw YAML, referenced with a bare `$name` and spliced in as text before the block is parsed. A snippet has no path into a result.

| Command | Effect |
| --- | --- |
| `vars` | Lists the result variables of the current context |
| `print <name>[.path] [file]`, `show` | Prints a variable, or a value inside it, as YAML; writes it to `<file>` when given |
| `copy <name>[.path] <to>` | Copies a variable, or a value inside it, to a new name; overwrites `<to>` |
| `snippet save <name>` | Captures the next block as `$name` |
| `snippet load <name> <file>` | Reads `$name` from a file |
| `snippet list` | Lists the saved snippets |

`print` and `copy` take the path of a placeholder without the `${}`, for example `r.after.0.name`.

## Model upgrades

A `schema` or `scalar_type` changes only against an upgrade locator, through ordinary `run` blocks naming `schema: schema` or `schema: scalar_type`.

| Command | Effect |
| --- | --- |
| `upgrade [<name>]` | Creates an upgrade locator for the current dataset (or `<name>`), opens it as the context `<source name> (upgrade)` and makes it current |
| `changes` | Lists the schemas and scalar types this upgrade added, changed or lost |
| `check` | Reports how many instances of the source dataset upgrade automatically, and how many carry a modified or lost schema |
| `commit` | Applies the upgrade to its source dataset, closes the upgrade context and makes the source current again |
| `discard` | Deletes the upgrade and closes its context |

An upgrade context is an ordinary context that knows its source, so `run`, `print` and `vars` work in it unchanged, and `open` on an upgrade locator left by an earlier process yields a context that `changes`, `check`, `commit` and `discard` accept. To author a model from a file, `snippet load` a YAML fragment and reference it as `$name` in a `create` command's `input`.

## Files and the rest

| Command | Effect |
| --- | --- |
| `save <file>` | Writes the commands run so far in the current context as a replayable script (`commands` array), not a data snapshot |
| `dump <file> [json\|yaml]` | Writes the current dataset (model and data) as a snapshot; read it back with `upload` |
| `log-level <level>` | Changes the log level without restarting |
| `help [mcl]` | Lists the meta-commands, or a cheat-sheet of the command language |
| `exit`, `quit` | Leaves the REPL |

## Limits

- No escape character in arguments: a token holding a literal double quote cannot be written.
- `snippet save` keeps a snippet in the session only; `save` of a script embeds its expansion, but the snippet is not written out.
- The REPL has no meta-command for transactions.
