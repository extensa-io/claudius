import { ObjectId } from "mongodb";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { AppError } from "@claudius/shared";
import { auth } from "@/lib/auth";
import { createDocument, toDocumentView } from "@/lib/documents";
import { errorResponse } from "@/lib/http";

export const runtime = "nodejs";

const CreateSchema = z.object({
  // null for an attachment to a not-yet-created conversation (associated on send).
  conversationId: z.string().min(1).nullish(),
  blobUrl: z.string().url(),
  filename: z.string().min(1).max(500),
  mimeType: z.string().max(255),
  sizeBytes: z.number().int().nonnegative(),
});

/**
 * Record a document the client just uploaded to Blob. This is the single
 * document-creation path (the Blob onUploadCompleted callback is not used; see
 * the upload route). Member/admin only — guests have no upload affordance and
 * are rejected here too. Returns the new document so the UI can show its chip and
 * then trigger parsing.
 */
export async function POST(req: NextRequest): Promise<Response> {
  try {
    const session = await auth();
    const user = session?.user;
    if (!user) {
      return Response.json({ error: { code: "unauthorized" } }, { status: 401 });
    }
    if (user.role === "guest") {
      throw new AppError(
        "model_not_permitted",
        "File uploads are not available on the guest tier.",
      );
    }

    const parsed = CreateSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      throw new AppError("invalid_input", "Invalid document.");
    }
    const { conversationId, blobUrl, filename, mimeType, sizeBytes } =
      parsed.data;

    const userId = new ObjectId(user.id);

    // If a conversation id is supplied it must be the user's own; an invalid or
    // unowned id is rejected rather than silently creating an orphan.
    let convId: ObjectId | null = null;
    if (conversationId) {
      if (!ObjectId.isValid(conversationId)) {
        throw new AppError("invalid_input", "Invalid conversation.");
      }
      convId = new ObjectId(conversationId);
    }

    const doc = await createDocument({
      userId,
      conversationId: convId,
      filename,
      blobUrl,
      mimeType,
      sizeBytes,
    });
    if (!doc) {
      throw new AppError("invalid_input", "Unsupported file type.");
    }

    return Response.json({ document: toDocumentView(doc) }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
