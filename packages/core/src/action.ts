import type { MclAccess } from "./types.js";

/**
 * JSON Schema describing the parameters of a model action.
 * Compatible with JSON Schema Draft-07.
 */
export interface ModelActionParamsSchema {
  type: "object";
  properties: Record<string, {
    type: string;
    description?: string;
    enum?: readonly (string | number)[];
    default?: unknown;
    items?: unknown;
    [key: string]: unknown;
  }>;
  required?: readonly string[];
  additionalProperties?: boolean;
}

/**
 * Definition of a semantic model action, exposed to UIs and AI assistants.
 *
 * Implemented by domain packages (for example a business package of a
 * domain model). An action receives an `MclAccess` and a dataset locator:
 * it can chain several MCL commands while staying pure and testable
 * without a shell.
 */
export interface ModelActionDefinition<
  TParams = Record<string, unknown>,
  TResult = unknown,
> {
  /** Unique scoped identifier (for example `"scflow/create_actor"`, `"scflow/connect_flow"`). */
  readonly id: string;

  /** Human-readable label, used in the UI and in the undo history. */
  readonly title: string;

  /** Clear semantic description, used by AI assistants and assistance features. */
  readonly description: string;

  /** Formal schema of the accepted parameters. */
  readonly parameters: ModelActionParamsSchema;

  /**
   * Kind of the action:
   * - `"read"`: a query or an inspection that writes nothing; a host runs it
   *   without opening an undo transaction.
   * - `"action"` (default): a mutation; a host runs it inside an undo transaction.
   */
  readonly kind?: "read" | "action";

  /**
   * Business logic of the action.
   * Runs the required MCL commands on the dataset designated by `locator`.
   */
  execute(
    access: MclAccess,
    locator: string,
    params: TParams,
  ): Promise<TResult>;
}
