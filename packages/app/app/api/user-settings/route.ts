import { ObjectId } from "mongodb";
import type { NextRequest } from "next/server";
import { z } from "zod";
import {
  AppError,
  getUsableModels,
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
    // The sticky model choice. A bare id (validated against the catalog below),
    // or null to clear the preference.
    preferredModelId: z.string().min(1).nullable().optional(),
  })
  .refine(
    (v) =>
      v.preferredName !== undefined ||
      v.instructions !== undefined ||
      v.preferredModelId !== undefined,
    { message: "Provide at least one field." },
  );

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

    // A sticky model preference must name a model this user's role actually
    // allows — otherwise a client could pin an off-limits model and have it
    // seed every new conversation, sneaking past the picker's server-filtered
    // options. Resolve against the same catalog the picker is built from.
    if (parsed.data.preferredModelId != null) {
      const usable = await getUsableModels(userId);
      if (!usable.some((m) => m.id === parsed.data.preferredModelId)) {
        throw new AppError("invalid_input", "That model isn't available to you.");
      }
    }

    const settings = await updateUserSettings(userId, parsed.data, new Date());
    return Response.json({ ok: true, settings });
  } catch (err) {
    return errorResponse(err);
  }
}
