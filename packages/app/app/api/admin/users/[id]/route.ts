import { ObjectId } from "mongodb";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { AppError, setUserRole, updateUser, zRole } from "@claudius/shared";
import { requireAdminApi } from "@/lib/auth/admin";
import { errorResponse } from "@/lib/http";

export const runtime = "nodejs";

const PatchSchema = z.object({
  role: zRole.optional(),
  status: z.enum(["active", "disabled"]).optional(),
  allowedModels: z.array(z.string()).nullable().optional(),
  monthlyTokenBudget: z.number().int().nonnegative().nullable().optional(),
});

/**
 * Admin: edit a user. A role change is dispatched to `setUserRole` (which syncs
 * the allowlists so it's durable across sign-in and guards the env admin); the
 * remaining fields go through `updateUser`.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    await requireAdminApi();
    const { id } = await params;
    if (!ObjectId.isValid(id)) {
      throw new AppError("invalid_input", "Invalid user id.");
    }
    const parsed = PatchSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      throw new AppError("invalid_input", "Invalid user update.");
    }
    const userId = new ObjectId(id);
    const { role, ...rest } = parsed.data;
    if (role !== undefined) await setUserRole(userId, role);
    if (Object.keys(rest).length > 0) await updateUser(userId, rest);
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
