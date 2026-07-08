import { ObjectId } from "mongodb";
import type { NextRequest } from "next/server";
import { z } from "zod";
import {
  AppError,
  updateUserSettings,
  USER_INSTRUCTIONS_MAX,
  USER_PREFERRED_NAME_MAX,
} from "@claudius/shared";
import { auth } from "@/lib/auth";
import { errorResponse } from "@/lib/http";

export const runtime = "nodejs";

/**
 * Both fields are optional in the patch (a caller may save just one), and each
 * accepts null to clear it. The shared layer trims and maps whitespace-only to
 * null, so an emptied textarea unsets the field rather than storing a blank.
 */
const PatchSchema = z
  .object({
    preferredName: z.string().max(USER_PREFERRED_NAME_MAX).nullable().optional(),
    instructions: z.string().max(USER_INSTRUCTIONS_MAX).nullable().optional(),
  })
  .refine((v) => v.preferredName !== undefined || v.instructions !== undefined, {
    message: "Provide at least one field.",
  });

/**
 * Save a user's authored personalization (preferred name + instructions). This
 * is the user-authored layer that outranks inferred memory in the prompt.
 * Members and admins only — guests never author settings (they're ephemeral and
 * capped), so a guest request is refused rather than silently written.
 */
export async function PATCH(req: NextRequest): Promise<Response> {
  try {
    const session = await auth();
    if (!session?.user) {
      return Response.json({ error: { code: "unauthorized" } }, { status: 401 });
    }
    if (session.user.role === "guest") {
      throw new AppError(
        "forbidden",
        "Custom instructions aren't available on the guest tier.",
      );
    }
    const userId = new ObjectId(session.user.id);

    const parsed = PatchSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      throw new AppError("invalid_input", "Invalid settings.");
    }

    const settings = await updateUserSettings(userId, parsed.data, new Date());
    return Response.json({ ok: true, settings });
  } catch (err) {
    return errorResponse(err);
  }
}
