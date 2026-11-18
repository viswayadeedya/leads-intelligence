export type AppErrorCode =
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'validation'
  | 'rate_limited'
  | 'budget_exceeded'
  | 'security_blocked'
  | 'approval_required'
  | 'conflict';

const HTTP_STATUS: Record<AppErrorCode, number> = {
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  validation: 400,
  rate_limited: 429,
  budget_exceeded: 429,
  security_blocked: 403,
  approval_required: 403,
  conflict: 409,
};

/** Errors whose message is safe to show the operator (no secrets, no source bodies). */
export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly httpStatus: number;
  constructor(code: AppErrorCode, message: string) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.httpStatus = HTTP_STATUS[code];
  }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}
