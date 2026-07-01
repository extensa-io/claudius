import { ObjectId } from "mongodb";
import { AppError, promoteToMember } from "@claudius/shared";
import { requireAdminApi } from "@/lib/auth/admin";
import { errorResponse } from "@/lib/http";

export const runtime = "nodejs";

/**
 * Admin: promote a guest to member. Sets the role AND adds the email to the
 * allowlist so a later re-provision on sign-in doesn't silently demote them.
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    await requireAdminApi();
    const { id } = await params;
    if (!ObjectId.isValid(id)) {
      throw new AppError("invalid_input", "Invalid user id.");
    }
    await promoteToMember(new ObjectId(id));
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
