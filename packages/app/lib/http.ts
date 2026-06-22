import { isAppError } from "@claudius/shared";

/**
 * Turn any thrown value into a client-safe JSON Response. An AppError carries a
 * vetted message, code, and status; anything else is an unexpected internal
 * fault and is flattened to a generic 500 so database errors, AWS internals, and
 * stack traces never reach the client (CLAUDE.md: never leak internals).
 */
export function errorResponse(err: unknown): Response {
  if (isAppError(err)) {
    return Response.json(
      { error: { code: err.code, message: err.message } },
      { status: err.status },
    );
  }
  // Server-side breadcrumb only; we log the message, never request content.
  console.error(
    "Unhandled route error:",
    err instanceof Error ? err.message : err,
  );
  return Response.json(
    { error: { code: "internal", message: "Something went wrong." } },
    { status: 500 },
  );
}
