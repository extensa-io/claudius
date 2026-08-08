import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { ObjectId } from "mongodb";
import {
  ALLOWED_UPLOAD_CONTENT_TYPES,
  AppError,
  MAX_DOCUMENT_BYTES,
} from "@claudius/shared";
import { auth } from "@/lib/auth";
import { errorResponse } from "@/lib/http";
import { enforceRateLimit } from "@/lib/ratelimit";

export const runtime = "nodejs";

/**
 * Issues short-lived client upload tokens for Vercel Blob. The browser uploads
 * file bytes straight to Blob with this token, never through a function body —
 * which is structural, not an optimization: a route body is capped at 4.5MB and
 * documents here go to 30MB.
 *
 * The DB record is created by the client's follow-up call to POST /api/documents
 * once `upload()` resolves, NOT by Vercel Blob's `onUploadCompleted` webhook. The
 * webhook can't see the user's session, never reaches a localhost dev server, and
 * would need BLOB_WEBHOOK_PUBLIC_KEY; the client call avoids all three and hands
 * the new document id straight back to the UI. So we omit onUploadCompleted
 * entirely and no webhook is wired.
 *
 * Auth note: client uploads require BLOB_READ_WRITE_TOKEN — handleUpload signs
 * the client token from it. The OIDC pair (BLOB_STORE_ID + VERCEL_OIDC_TOKEN)
 * only authenticates server-side blob ops, not client-token generation.
 */
export async function POST(request: Request): Promise<Response> {
  let body: HandleUploadBody;
  try {
    body = (await request.json()) as HandleUploadBody;
  } catch {
    return errorResponse(new AppError("invalid_input", "Malformed request."));
  }

  try {
    const result = await handleUpload({
      body,
      request,
      // Runs only for the token-generation request, which carries the browser's
      // session cookies — so the role gate here is the real upload authorization.
      onBeforeGenerateToken: async () => {
        const session = await auth();
        const user = session?.user;
        if (!user) {
          throw new AppError("unauthorized", "Sign in to upload files.");
        }
        // Invariant #7-adjacent: uploads are a member/admin feature; guests are
        // rejected at the source, matching the hidden affordance in the UI.
        if (user.role === "guest") {
          throw new AppError(
            "model_not_permitted",
            "File uploads are not available on the guest tier.",
          );
        }
        // Burst backstop on the upload-token endpoint.
        await enforceRateLimit(new ObjectId(user.id), "upload");
        return {
          allowedContentTypes: ALLOWED_UPLOAD_CONTENT_TYPES,
          maximumSizeInBytes: MAX_DOCUMENT_BYTES,
          // Avoid filename collisions across a user's uploads.
          addRandomSuffix: true,
          tokenPayload: JSON.stringify({ userId: user.id }),
        };
      },
      // onUploadCompleted intentionally omitted — see the note above.
    });

    return Response.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
