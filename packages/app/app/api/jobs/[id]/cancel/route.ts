import { ObjectId } from "mongodb";
import type { NextRequest } from "next/server";
import { AppError, requestJobCancel } from "@claudius/shared";
import { auth } from "@/lib/auth";
import { errorResponse } from "@/lib/http";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * Cancel a research job. Owner-scoped; only a queued or running job transitions.
 * Setting status `cancelled` is the whole protocol — the worker honors it between
 * steps, so a running job stops within one step (an acceptance criterion).
 */
export async function POST(
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

    const cancelled = await requestJobCancel(userId, new ObjectId(id));
    if (!cancelled) {
      throw new AppError("not_found", "No cancellable job found.");
    }
    return Response.json({ ok: true, cancelled: true });
  } catch (err) {
    return errorResponse(err);
  }
}
