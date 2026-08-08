import { ObjectId } from "mongodb";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { enforceRateLimit } from "@/lib/ratelimit";

export const runtime = "nodejs";

/**
 * Sink for errors that happen in the browser and therefore never touch a
 * function of ours.
 *
 * Uploads are the reason this exists. Bytes go straight from the browser to
 * Vercel Blob so a 20MB file never meets the 4.5MB route body limit, which means
 * a failed upload runs no server code and leaves no trace in the logs: the user
 * sees "Failed" and we see nothing at all.
 *
 * Deliberately a log line and not a collection: this is diagnostic breadcrumbs,
 * not app data, so it earns no documents, no indexes and no retention policy.
 */
const ReportSchema = z.object({
  // Where in the app it happened, e.g. "upload" or "window".
  stage: z.string().min(1).max(40),
  message: z.string().min(1).max(300),
  // Coarse shape of the file involved, never the filename: invariant #5 keeps
  // user content out of the logs, and a name like "Q3-severance-agreement.pdf"
  // is exactly the content it means.
  extension: z.string().max(20).nullish(),
  sizeBucket: z.string().max(20).nullish(),
  // Set when the browser gave us a stack; trimmed hard since we only want the
  // top frames to identify the code path.
  stack: z.string().max(1000).nullish(),
  // How many times this exact error had happened on the page when the report
  // was sent. Present only on a repeat: the client reports repeats on a
  // doubling curve, so "occurrence: 64" means a loop, not 64 log lines.
  occurrence: z.number().int().positive().nullish(),
});

export async function POST(request: Request): Promise<Response> {
  // 204 on every path, including failure. A reporting endpoint that can itself
  // report an error invites a loop, and the client has nothing useful to do
  // with the answer either way.
  const noContent = new Response(null, { status: 204 });

  try {
    const session = await auth();
    const user = session?.user;
    if (!user) return noContent;

    await enforceRateLimit(new ObjectId(user.id), "clientError");

    const parsed = ReportSchema.safeParse(await request.json());
    if (!parsed.success) return noContent;
    const { stage, message, extension, sizeBucket, stack, occurrence } =
      parsed.data;

    // The user id (not email) is enough to correlate with other log lines while
    // keeping an identifier out of the log stream.
    console.error("Client error:", {
      stage,
      message,
      userId: user.id,
      ...(occurrence ? { occurrence } : {}),
      ...(extension ? { extension } : {}),
      ...(sizeBucket ? { sizeBucket } : {}),
      ...(stack ? { stack } : {}),
    });
  } catch {
    // Includes the rate-limit rejection: dropping the report is the intended
    // outcome, so it stays silent.
  }

  return noContent;
}
