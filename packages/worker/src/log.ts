/**
 * A minimal structured logger for the worker. Railway captures stdout/stderr, so
 * plain lines with a level prefix are enough. It never logs message content or
 * secrets (invariant #5) — callers pass short, non-sensitive context strings.
 */
type Level = "info" | "warn" | "error";

function emit(level: Level, message: string, context?: Record<string, unknown>): void {
  const line = context
    ? `[worker] ${message} ${JSON.stringify(context)}`
    : `[worker] ${message}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  info: (message: string, context?: Record<string, unknown>) =>
    emit("info", message, context),
  warn: (message: string, context?: Record<string, unknown>) =>
    emit("warn", message, context),
  error: (message: string, context?: Record<string, unknown>) =>
    emit("error", message, context),
};

/** Reduce an unknown thrown value to a safe `name: message` string for logs. */
export function errMsg(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}
