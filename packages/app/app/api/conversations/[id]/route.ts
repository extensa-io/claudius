import { ObjectId } from "mongodb";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { AppError, loadThreadMessages } from "@claudius/shared";
import { auth } from "@/lib/auth";
import {
  getOwnedConversation,
  setArchived,
  toSummary,
} from "@/lib/chat/conversations";
import { toUIMessages } from "@/lib/chat/messages";
import { listConversationDocuments } from "@/lib/documents";
import { errorResponse } from "@/lib/http";
import { getActiveResearchJobViews } from "@/lib/jobs/view";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * Resume payload for one conversation: its metadata plus the full transcript,
 * read from the checkpointer and mapped to UI messages. Ownership is enforced
 * by getOwnedConversation; a non-owned or missing id is an indistinguishable 404.
 */
export async function GET(
  _req: NextRequest,
  ctx: RouteContext,
): Promise<Response> {
  try {
    const session = await auth();
    if (!session?.user) {
      return Response.json(
        { error: { code: "unauthorized" } },
        { status: 401 },
      );
    }
    const userId = new ObjectId(session.user.id);
    const { id } = await ctx.params;

    const conversation = await getOwnedConversation(userId, id);
    if (!conversation) {
      throw new AppError("not_found", "Conversation not found.");
    }

    const [messages, documents, jobs] = await Promise.all([
      loadThreadMessages(id).then(toUIMessages),
      listConversationDocuments(userId, conversation._id!),
      getActiveResearchJobViews(userId, conversation._id!),
    ]);
    return Response.json({
      conversation: toSummary(conversation),
      messages,
      documents,
      jobs,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

const PatchSchema = z.object({ archived: z.boolean() });

/** Archive / unarchive a conversation. Scoped to the owner inside setArchived. */
export async function PATCH(
  req: NextRequest,
  ctx: RouteContext,
): Promise<Response> {
  try {
    const session = await auth();
    if (!session?.user) {
      return Response.json(
        { error: { code: "unauthorized" } },
        { status: 401 },
      );
    }
    const userId = new ObjectId(session.user.id);
    const { id } = await ctx.params;

    const parsed = PatchSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      throw new AppError("invalid_input", "Invalid update.");
    }

    const conversation = await setArchived(userId, id, parsed.data.archived);
    return Response.json({ conversation });
  } catch (err) {
    return errorResponse(err);
  }
}
