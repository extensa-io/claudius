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

/** The extension alone, lowercased, never the filename (invariant #5). */
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

/**
 * Volume guards, both scoped to one page load.
 *
 * A looping render or a throwing interval emits errors as fast as the event
 * loop turns, and the server-side rate limit can't help: it caps what gets
 * logged, not what the browser sends, so the requests are already in flight
 * when the route drops them. That matters because keepalive requests draw on a
 * 64KiB budget shared across everything in flight for the page, and a fetch
 * that would exceed it is rejected outright rather than truncated. Reporting
 * would go silently dark exactly when something is badly wrong.
 *
 * So: a hard ceiling per page load, and repeats of an identical error reported
 * on a doubling curve (1st, 2nd, 4th, 8th...) carrying their occurrence count.
 * The count is what makes a loop legible in the logs without printing it 300
 * times.
 */
const MAX_REPORTS_PER_PAGE = 20;
const seen = new Map<string, number>();
let sent = 0;

export function reportClientError(report: ClientErrorReport): void {
  if (typeof window === "undefined") return;
  if (sent >= MAX_REPORTS_PER_PAGE) return;

  const message = report.message.slice(0, 300);
  const key = `${report.stage}|${message}`;
  const occurrence = (seen.get(key) ?? 0) + 1;
  seen.set(key, occurrence);

  // A power of two, which is also true of the first occurrence.
  const isMilestone = (occurrence & (occurrence - 1)) === 0;
  if (!isMilestone) return;

  sent += 1;
  const body = JSON.stringify({
    ...report,
    message,
    ...(occurrence > 1 ? { occurrence } : {}),
    ...(report.stack ? { stack: report.stack.slice(0, 1000) } : {}),
  });

  // keepalive so a report sent while the page is being torn down still leaves
  // the browser: the unhandled-error case is exactly when navigation follows.
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
