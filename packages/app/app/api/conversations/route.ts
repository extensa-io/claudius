import { ObjectId } from "mongodb";
import { auth } from "@/lib/auth";
import { listConversations } from "@/lib/chat/conversations";
import { errorResponse } from "@/lib/http";

export const runtime = "nodejs";

/** The signed-in user's conversations for the sidebar, newest activity first. */
export async function GET(): Promise<Response> {
  try {
    const session = await auth();
    if (!session?.user) {
      return Response.json(
        { error: { code: "unauthorized" } },
        { status: 401 },
      );
    }
    const userId = new ObjectId(session.user.id);
    const conversations = await listConversations(userId);
    return Response.json({ conversations });
  } catch (err) {
    return errorResponse(err);
  }
}
