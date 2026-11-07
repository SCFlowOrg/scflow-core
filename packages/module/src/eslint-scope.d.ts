// The part of eslint-scope that the bundle check uses; the package ships no types.
declare module "eslint-scope" {
  import type { Identifier, Node } from "estree";

  export interface Reference {
    readonly identifier: Identifier;
    readonly resolved: unknown;
  }

  export interface Scope {
    readonly through: readonly Reference[];
  }

  export interface ScopeManager {
    readonly globalScope: Scope | null;
  }

  export function analyze(
    ast: Node,
    options: { ecmaVersion: number; sourceType: "module" | "script" },
  ): ScopeManager;
}
