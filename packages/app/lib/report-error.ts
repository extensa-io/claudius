/**
 * Ships a browser-side error to /api/client-errors so failures that never touch
 * a function of ours still land in the logs. See that route for why.
 *
 * Every call is fire-and-forget and swallows its own failure: reporting must
 * never be able to break, or worse re-enter, the code path that was already
 * failing.
 */

/** Coarse size band, so the logs describe the file without identifying it. */
export function sizeBucketOf(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb < 1) return "<1MB";
  if (mb < 5) return "1-5MB";
  if (mb < 10) return "5-10MB";
  if (mb < 20) return "10-20MB";
  return ">20MB";
}

/** The extension alone, lowercased — never the filename (invariant #5). */
export function extensionOf(filename: string): string | null {
  const dot = filename.lastIndexOf(".");
  if (dot <= 0 || dot === filename.length - 1) return null;
  return filename.slice(dot + 1).toLowerCase().slice(0, 20);
}

export type ClientErrorReport = {
  stage: string;
  message: string;
  extension?: string | null;
  sizeBucket?: string | null;
  stack?: string | null;
};

export function reportClientError(report: ClientErrorReport): void {
  if (typeof window === "undefined") return;

  const body = JSON.stringify({
    ...report,
    message: report.message.slice(0, 300),
    ...(report.stack ? { stack: report.stack.slice(0, 1000) } : {}),
  });

  // keepalive so a report sent while the page is being torn down still leaves
  // the browser — the unhandled-error case is exactly when navigation follows.
  void fetch("/api/client-errors", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    keepalive: true,
  }).catch(() => {
    // Nothing to do: the network is the thing that just failed.
  });
}

export function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "Unknown error";
}
