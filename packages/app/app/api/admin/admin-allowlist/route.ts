import type { NextRequest } from "next/server";
import { z } from "zod";
import {
  addAdminEmail,
  AppError,
  getAdminAllowlist,
  removeAdminEmail,
} from "@claudius/shared";
import { requireAdminApi } from "@/lib/auth/admin";
import { errorResponse } from "@/lib/http";

export const runtime = "nodejs";

const BodySchema = z.object({ email: z.string() });

export async function GET(): Promise<Response> {
  try {
    await requireAdminApi();
    return Response.json({ emails: await getAdminAllowlist() });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Grant admin to an email (revocable; the env ADMIN_EMAIL is separate). */
export async function POST(req: NextRequest): Promise<Response> {
  try {
    await requireAdminApi();
    const parsed = BodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new AppError("invalid_input", "Email required.");
    await addAdminEmail(parsed.data.email);
    return Response.json({ ok: true, emails: await getAdminAllowlist() });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Revoke a settings-granted admin. Does not affect the env ADMIN_EMAIL. */
export async function DELETE(req: NextRequest): Promise<Response> {
  try {
    await requireAdminApi();
    const parsed = BodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new AppError("invalid_input", "Email required.");
    await removeAdminEmail(parsed.data.email);
    return Response.json({ ok: true, emails: await getAdminAllowlist() });
  } catch (err) {
    return errorResponse(err);
  }
}
