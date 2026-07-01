/**
 * The one error type that route handlers are allowed to surface to a client.
 *
 * Every field on it is safe to send over the wire: `message` is written for a
 * human, `code` is a stable machine-readable string the UI can branch on, and
 * `status` is the HTTP status to respond with. Anything thrown that is *not* an
 * AppError is treated as an internal fault and reduced to a generic 500 by the
 * route, so database errors, AWS SDK internals, and stack traces never leak.
 *
 * (CLAUDE.md invariant: errors are typed result objects or a thrown AppError
 * with a user-safe message; never leak internals to the client.)
 */
export type AppErrorCode =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "invalid_input"
  | "model_not_permitted"
  | "daily_cap_reached"
  | "monthly_budget_reached"
  | "rate_limited"
  | "circuit_breaker_tripped"
  | "guest_access_disabled"
  | "account_disabled"
  | "internal";

const DEFAULT_STATUS: Record<AppErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  invalid_input: 400,
  model_not_permitted: 403,
  daily_cap_reached: 429,
  monthly_budget_reached: 429,
  rate_limited: 429,
  circuit_breaker_tripped: 429,
  guest_access_disabled: 403,
  account_disabled: 403,
  internal: 500,
};

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly status: number;

  constructor(code: AppErrorCode, message: string, status?: number) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status ?? DEFAULT_STATUS[code];
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}
