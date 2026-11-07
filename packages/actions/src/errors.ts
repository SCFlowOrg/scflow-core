/** Every code an `ActionError` carries, each with the condition that raises it. */
export const ActionErrorCode = {
  /** The parameters break the JSON Schema of the action, or a `ref` matches no instance or several. */
  invalid_parameters: "invalid_parameters",
  /** An id names no action of the registry. */
  unknown_action: "unknown_action",
  /** An action is registered with the id of another one. */
  duplicate_name: "duplicate_name",
  /** An action is registered with an id or parameters that are not valid. */
  constraint_violation: "constraint_violation",
  /** A step of a batch is not a `call` with only `with` and `as`, or a batch has `parameters`. */
  invalid_script_step: "invalid_script_step",
  /** A placeholder of a batch names an `as` name that is not set yet. */
  unknown_reference: "unknown_reference",
} as const;

/** The name of one code of `ActionErrorCode`. */
export type ActionErrorCodeName = keyof typeof ActionErrorCode;

/**
 * The error this package throws: `code` names the cause, with the names the
 * engine uses for the same causes, so a caller branches on `.code` alike.
 */
export class ActionError extends Error {
  readonly code: ActionErrorCodeName;

  constructor(code: ActionErrorCodeName, message?: string) {
    super(message ?? code);
    this.name = "ActionError";
    this.code = code;
  }
}

/** Builds an `ActionError`; `message` defaults to the code. */
export function actionError(code: ActionErrorCodeName, message?: string): ActionError {
  return new ActionError(code, message);
}

/** The code of an exception when it has one, otherwise its message: the `error` of a refused run entry. */
export function errorCodeOf(error: unknown): string {
  if (error !== null && typeof error === "object") {
    const { code, message } = error as { code?: unknown; message?: unknown };
    if (typeof code === "string") return code;
    if (typeof message === "string") return message;
  }
  return String(error);
}
