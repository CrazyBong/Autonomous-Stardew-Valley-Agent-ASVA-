/**
 * AppError — typed error class for all agent failures.
 * Never throw raw Error; always throw AppError with a code.
 * Rule 02 (GEMINI): no silent failures, typed error class, no stack traces in API responses.
 */
export class AppError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  public readonly details?: unknown;

  constructor(
    code: string,
    message: string,
    statusCode: number = 500,
    options?: { cause?: unknown; details?: unknown }
  ) {
    super(message, { cause: options?.cause });
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = options?.details;

    // Maintains proper prototype chain in transpiled ES5 output
    Object.setPrototypeOf(this, AppError.prototype);
  }

  public toJSON() {
    return {
      code: this.code,
      message: this.message,
      statusCode: this.statusCode,
      details: this.details,
    };
  }

  public static isAppError(err: unknown): err is AppError {
    return err instanceof AppError;
  }
}

// ── Standard Error Codes ──────────────────────────────────────────────────────

export const ErrorCodes = {
  // Infrastructure
  BRIDGE_DISCONNECTED: 'BRIDGE_DISCONNECTED',
  BRIDGE_TIMEOUT: 'BRIDGE_TIMEOUT',
  // LLM
  OLLAMA_UNAVAILABLE: 'OLLAMA_UNAVAILABLE',
  OLLAMA_TIMEOUT: 'OLLAMA_TIMEOUT',
  LLM_INVALID_RESPONSE: 'LLM_INVALID_RESPONSE',
  LLM_CALL_FAILED: 'LLM_CALL_FAILED',
  // Execution
  PATH_NOT_FOUND: 'PATH_NOT_FOUND',
  STAMINA_EXHAUSTED: 'STAMINA_EXHAUSTED',
  TASK_EXECUTION_FAILED: 'TASK_EXECUTION_FAILED',
  // Planning
  TASK_DEPENDENCY_FAILED: 'TASK_DEPENDENCY_FAILED',
  REPLAN_LIMIT_EXCEEDED: 'REPLAN_LIMIT_EXCEEDED',
  // Data
  DB_WRITE_FAILED: 'DB_WRITE_FAILED',
  DB_READ_FAILED: 'DB_READ_FAILED',
  // Config
  CONFIG_INVALID: 'CONFIG_INVALID',
  CONFIG_NOT_FOUND: 'CONFIG_NOT_FOUND',
  // Validation
  SCHEMA_VALIDATION_FAILED: 'SCHEMA_VALIDATION_FAILED',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];
