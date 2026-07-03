import { ObjectId } from "mongodb";
import type { NextRequest } from "next/server";
import { AppError, getJobForOwner } from "@claudius/shared";
import { auth } from "@/lib/auth";
import { errorResponse } from "@/lib/http";
import { serializeJob } from "@/lib/jobs/view";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * The job status the client polls for live research progress. Owner-scoped
 * (invariant #1): a job that isn't this user's — or a bad id — is an
 * indistinguishable 404, so no one can observe another user's research.
 */
export async function GET(
  _req: NextRequest,
  ctx: RouteContext,
): Promise<Response> {
  try {
    const session = await auth();
    if (!session?.user) {
      return Response.json({ error: { code: "unauthorized" } }, { status: 401 });
    }
    const userId = new ObjectId(session.user.id);
    const { id } = await ctx.params;
    if (!ObjectId.isValid(id)) {
      throw new AppError("not_found", "Job not found.");
    }

    const job = await getJobForOwner(userId, new ObjectId(id));
    if (!job) throw new AppError("not_found", "Job not found.");
    return Response.json({ job: serializeJob(job) });
  } catch (err) {
    return errorResponse(err);
  }
}
