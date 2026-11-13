/**
 * `defineModule`, the default export of the entry of a module package
 * (`src/module.ts`), and its types (see `docs/module-packages.md`).
 *
 * This entry has no runtime dependency, so a bundle inlines it and holds
 * nothing else: it must stay free of any import other than a type.
 */

/**
 * The body of an action or of a migration, as a module package gives it. A body
 * is a pure function whose only effect is to emit MCL commands (the contract of
 * a body, `packages/core/docs/spec/meta-model.md`, section Action). The context
 * it receives is the context of actions, which the environment gives; this
 * package does not call it.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ModuleBody = (...args: any[]) => unknown;

/** Reads the Markdown body of a skill when a host needs it. */
export type SkillLoader = () => Promise<string>;

/** Reads the Markdown body of a documentation topic when a host needs it. */
export type DocLoader = () => Promise<string>;

/** The manifest of a module as `src/module.ts` imports it from `module.yaml`. */
export type ModuleManifestSource = Readonly<Record<string, unknown>>;

/** The code of a module, the second argument of `defineModule`. */
export interface ModuleCode {
  /** The body of each action, by its name: the part of its id after the slash. */
  readonly actions?: Readonly<Record<string, ModuleBody>>;
  /** The body of each migration, by the version it reaches. */
  readonly migrations?: Readonly<Record<string, ModuleBody>>;
  /**
   * The body of each skill, by its name: the part of its id after the slash.
   * A body is the Markdown text of the `file` the manifest names, which
   * `src/module.ts` imports; `buildModule` inlines it and checks it against
   * the file.
   */
  readonly skills?: Readonly<Record<string, string>>;
  /**
   * The body of each documentation topic, by the `file` its entry in `docs`
   * names (a topic and its translations have different files). A body is the
   * Markdown text of that file, which `src/module.ts` imports; `buildModule`
   * inlines it and checks it against the file.
   */
  readonly docs?: Readonly<Record<string, string>>;
}

/** What `defineModule` returns: the default export of a bundle. */
export interface ModuleDefinition {
  readonly manifest: ModuleManifestSource;
  readonly actions: Readonly<Record<string, ModuleBody>>;
  readonly migrations: Readonly<Record<string, ModuleBody>>;
  readonly skills: Readonly<Record<string, string>>;
  readonly docs: Readonly<Record<string, string>>;
}

/**
 * Declares the code of a module beside its manifest. It checks nothing and
 * copies the maps it is given, frozen: the host checks the code against the
 * manifest when it loads the module (`modules.load` of `@scfloworg/module/host`).
 */
export function defineModule(manifest: ModuleManifestSource, code: ModuleCode = {}): ModuleDefinition {
  return Object.freeze({
    manifest,
    actions: Object.freeze({ ...(code.actions ?? {}) }),
    migrations: Object.freeze({ ...(code.migrations ?? {}) }),
    skills: Object.freeze({ ...(code.skills ?? {}) }),
    docs: Object.freeze({ ...(code.docs ?? {}) }),
  });
}
