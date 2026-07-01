import type { NextRequest } from "next/server";
import { z } from "zod";
import { AppError, loadTier, TierSchema, updateTiers } from "@claudius/shared";
import { requireAdminApi } from "@/lib/auth/admin";
import { errorResponse } from "@/lib/http";

export const runtime = "nodejs";

const BodySchema = z.object({
  admin: TierSchema,
  member: TierSchema,
  guest: TierSchema,
});

export async function GET(): Promise<Response> {
  try {
    await requireAdminApi();
    const [admin, member, guest] = await Promise.all([
      loadTier("admin"),
      loadTier("member"),
      loadTier("guest"),
    ]);
    return Response.json({ tiers: { admin, member, guest } });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Replace tier limits (daily caps, memory caps, monthly budgets, features). */
export async function PUT(req: NextRequest): Promise<Response> {
  try {
    await requireAdminApi();
    const parsed = BodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      throw new AppError("invalid_input", "Invalid tier configuration.");
    }
    await updateTiers(parsed.data);
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
