import { ObjectId } from "mongodb";
import type { NextRequest } from "next/server";
import { AppError, parseAndEmbedDocument } from "@claudius/shared";
import { auth } from "@/lib/auth";
import { getOwnedDocument, toDocumentView } from "@/lib/documents";
import { errorResponse } from "@/lib/http";

// Parsing fetches the file, extracts text, and embeds every chunk. 60s is the
// Vercel Hobby ceiling; we size the chunk cap (see MAX_CHUNKS_PER_DOCUMENT) so a
// normal document finishes well inside it and an oversized one fails fast and
// gracefully before the slow embedding step. Phase 4's worker removes this
// constraint by taking ingestion off the request path; raise this to 300 then.
export const runtime = "nodejs";
export const maxDuration = 60;

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * Run (or retry) the ingestion pipeline for one uploaded document. Member/admin
 * only and ownership-checked. Holds the request open until the document reaches
 * `embedded` or `failed`, then returns the document so the UI can update its chip
 * without polling. A failed parse returns 200 with status "failed" and a reason —
 * the failure is a document state, not a request error, and the UI offers retry.
 */
export async function POST(
  _req: NextRequest,
  ctx: RouteContext,
): Promise<Response> {
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

    const userId = new ObjectId(user.id);
    const { id } = await ctx.params;

    const document = await getOwnedDocument(userId, id);
    if (!document) {
      throw new AppError("not_found", "Document not found.");
    }

    await parseAndEmbedDocument(document);

    // Re-read so the response reflects the final status and any failure reason.
    const updated = await getOwnedDocument(userId, id);
    if (!updated) throw new AppError("not_found", "Document not found.");
    return Response.json({ document: toDocumentView(updated) });
  } catch (err) {
    return errorResponse(err);
  }
}
