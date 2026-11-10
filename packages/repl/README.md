# @scfloworg/repl

An interactive REPL for the Model Command Language of `@scfloworg/core`. A session is an incrementally typed script: each block of YAML entered runs at once against the current dataset, and named results carry forward as in a script.

## Start

```
model-repl [--init <file>] [--format-module <specifier>]... [--log-file <path>] [--log-level <level>]
```

- `--format-module <specifier>`: imports `<specifier>` and registers the `PersistenceInterface` it exports as `format`. Repeatable, in order; registering a name already taken overwrites it with a warning. No format is built in, `js` included: a `js:` locator needs `--format-module @scfloworg/format-js`, otherwise it fails with `unknown_persistent_format`. A specifier that fails to import, or has no valid `format` export, aborts startup.
- `--init <file>`: runs the file's lines, meta-commands and command blocks alike, before the first prompt, as if typed there. A failed line does not abort the file; an unreadable file aborts startup. Everything the file opens or sets is still there once the prompt starts.
- `--log-file`, `--log-level`: see Logging below.

## A short session

```
> new js:mydb db1
created "db1" -> js:mydb (current)
db1> run
... kind: query
... schema: dataset
...
before: 1  after: 1  cascade-deleted: 0  updated-before: 0  updated-after: 0
db1> print r.after.0.name
db1
```

Every line is a meta-command; `run` is the way to enter YAML. The commands, dataset contexts, variables, snippets and model upgrades are described in [docs/commands.md](docs/commands.md); `help` and `help mcl` list them in the REPL.

The REPL reads a dataset and changes its model. A `create`, `update` or `delete` of data fails with `write_outside_action`: data changes through actions, with the `scflow` command. A test passes `createReplState` a session from `@scfloworg/core/testing`.

## Logging

The REPL logs to its own stderr, never to stdout, which carries the prompt and the command output. `--log-file <path>` logs to a file instead, as one JSON line per call (`{ts, level, msg, ...context}`). The starting level is `warn`, quieter than the MCP server's `info`, because a command's own output already prints to stdout on every run and a log line on the same terminal would interleave with it; `--log-level debug|info|warn|error` sets it, and the `log-level <level>` meta-command changes it while running. Every command block logs `command executed` (`info`) or `command failed` (`error`), and every meta-command logs at `debug`.

## Layout

`src/repl.ts` is the input loop, `src/meta.ts` the meta-commands, `src/commandBlock.ts` the command blocks, `src/datasets.ts` the dataset contexts and `src/state.ts` the state. `src/io.ts` abstracts input and output so tests drive the loop without a terminal. `packages/repl-conformance` runs fixtures through the same parser a typed block uses.

## The `scflow` command

`scflow` works on a project on disk through actions, by hand or through a language model with `ask`, while `model-repl` stays for the command language. See [docs/scflow.md](docs/scflow.md).
