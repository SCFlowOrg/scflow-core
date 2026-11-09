import { createApiSession, noopLogger } from "@scfloworg/core";
import type { ApiSession, Logger, ScriptCommand, ScriptSession } from "@scfloworg/core";

/**
 * One open dataset of a REPL process, registered under its own `name`. A
 * dataset has no alias: it is known by the name that `new`, `open` or `upload`
 * gave it or found stored on it.
 *
 * Each context has its own `ScriptSession`, hence its own `variables` map,
 * because a `Key` is only meaningful within its own dataset and must never
 * cross contexts. The schemas and scalar types behind a context's session may
 * be shared with other contexts open on the same `locator` (see
 * `ReplState.apiSession`).
 */
export interface DatasetContext {
  readonly name: string;
  readonly locator: string;
  readonly session: ScriptSession;
  /** Successfully run commands, in order: the source of the `save <file>` meta-command. */
  readonly history: ScriptCommand[];
  /**
   * The locator of the dataset this context holds a model upgrade for, when
   * `locator` is an upgrade locator; `null` for an ordinary dataset. It is
   * read from the upgrade locator's own marker, so a context opened with
   * `open` on an upgrade locator left behind by an earlier process knows what
   * it belongs to. `changes`, `check`, `commit` and `discard` require it.
   */
  readonly upgradeOf: string | null;
}

/** The state of a REPL process: its dataset contexts, snippets, API session and logger. */
export interface ReplState {
  /** Keyed by `DatasetContext.name`. Registering a name already in use overwrites the entry (see `registerOpenContext`). */
  readonly contexts: Map<string, DatasetContext>;
  currentName: string | null;
  /** Saved YAML snippets, keyed by name without the `$`. */
  readonly snippets: Map<string, string>;
  /**
   * One `ApiSession` for the process's whole lifetime. Every context's
   * `ScriptSession` comes from it, so the schemas and scalar types of a
   * locator load once, on the first open of that locator, and are reused by
   * every context opened on it afterward, including a second open under
   * another name. A model change made outside this process is not seen until
   * a new process opens the locator; a change applied through `commit` drops
   * the cached entry.
   */
  readonly apiSession: ApiSession;
  /**
   * One `Logger` for the process's whole lifetime. `commandBlock.ts` logs each
   * command run through it, `meta.ts` logs each dispatched meta-command, and
   * the `log-level` meta-command assigns its `level`, which takes effect on
   * the next line logged.
   */
  readonly logger: Logger;
}

/**
 * Creates an empty REPL state.
 *
 * @param options.logger - the process's logger; defaults to `noopLogger`.
 * @param options.apiSession - the session the commands run on; defaults to one that refuses a write of data outside an action.
 */
export function createReplState(options: { logger?: Logger; apiSession?: ApiSession } = {}): ReplState {
  return {
    contexts: new Map(),
    currentName: null,
    snippets: new Map(),
    apiSession: options.apiSession ?? createApiSession(),
    logger: options.logger ?? noopLogger,
  };
}

/** The current dataset context, or `null` when none is open. */
export function currentContext(state: ReplState): DatasetContext | null {
  if (state.currentName === null) return null;
  return state.contexts.get(state.currentName) ?? null;
}
