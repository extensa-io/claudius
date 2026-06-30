import { ObjectId } from "mongodb";
import type { NextRequest } from "next/server";
import { AppError } from "@claudius/shared";
import { auth } from "@/lib/auth";
import { getOwnedConversation } from "@/lib/chat/conversations";
import { listConversationDocuments } from "@/lib/documents";
import { errorResponse } from "@/lib/http";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * The documents attached to a conversation, for rendering chips when a
 * conversation is opened. Ownership of the conversation is verified first, and
 * the document query is itself userId-scoped (invariant #1, belt and braces).
 */
export async function GET(
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

    const conversation = await getOwnedConversation(userId, id);
    if (!conversation) {
      throw new AppError("not_found", "Conversation not found.");
    }

    const documents = await listConversationDocuments(
      userId,
      conversation._id!,
    );
    return Response.json({ documents });
  } catch (err) {
    return errorResponse(err);
  }
}
