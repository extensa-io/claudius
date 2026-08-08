"use client";

import { useEffect } from "react";
import { messageOf, reportClientError } from "@/lib/report-error";

/**
 * Catches browser errors nothing else caught and forwards them to the log sink.
 * Mounted once in the root layout; renders nothing.
 *
 * Both listeners are needed and they don't overlap: "error" covers synchronous
 * throws, "unhandledrejection" covers a rejected promise nobody awaited, which
 * is the shape most async failures in this app actually take.
 */
export function ClientErrorReporter(): null {
  useEffect(() => {
    const onError = (event: ErrorEvent): void => {
      reportClientError({
        stage: "window",
        message: event.message || messageOf(event.error),
        stack: event.error instanceof Error ? (event.error.stack ?? null) : null,
      });
    };

    const onRejection = (event: PromiseRejectionEvent): void => {
      reportClientError({
        stage: "unhandledrejection",
        message: messageOf(event.reason),
        stack:
          event.reason instanceof Error ? (event.reason.stack ?? null) : null,
      });
    };

    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  return null;
}
