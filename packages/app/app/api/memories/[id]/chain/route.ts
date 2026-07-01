import { ObjectId } from "mongodb";
import type { NextRequest } from "next/server";
import { getSupersessionChain } from "@claudius/shared";
import { auth } from "@/lib/auth";
import { errorResponse } from "@/lib/http";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * The full supersession history behind a memory, newest predecessor first. Powers
 * the "↳ replaced an earlier memory" expander on a card. Owner-scoped.
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

    const chain = await getSupersessionChain(userId, id);
    return Response.json({ chain });
  } catch (err) {
    return errorResponse(err);
  }
}
