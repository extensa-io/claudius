import { ObjectId } from "mongodb";
import type { NextRequest } from "next/server";
import { AppError } from "@claudius/shared";
import { auth } from "@/lib/auth";
import { deleteDocument } from "@/lib/documents";
import { errorResponse } from "@/lib/http";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * Detach a document from its conversation. Documents are conversation-scoped
 * this phase, so detaching removes the record and its chunks. Ownership is
 * enforced inside deleteDocument; a missing or unowned id is an indistinguishable
 * 404.
 */
export async function DELETE(
  _req: NextRequest,
  ctx: RouteContext,
): Promise<Response> {
  try {
    const session = await auth();
    const user = session?.user;
    if (!user) {
      return Response.json({ error: { code: "unauthorized" } }, { status: 401 });
    }
    const userId = new ObjectId(user.id);
    const { id } = await ctx.params;

    const removed = await deleteDocument(userId, id);
    if (!removed) {
      throw new AppError("not_found", "Document not found.");
    }
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
