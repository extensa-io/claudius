import type { NextRequest } from "next/server";
import { z } from "zod";
import {
  addAllowlistEmail,
  AppError,
  getAllowlist,
  removeAllowlistEmail,
} from "@claudius/shared";
import { requireAdminApi } from "@/lib/auth/admin";
import { errorResponse } from "@/lib/http";

export const runtime = "nodejs";

const BodySchema = z.object({ email: z.string() });

export async function GET(): Promise<Response> {
  try {
    await requireAdminApi();
    return Response.json({ emails: await getAllowlist() });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Add an email to the member allowlist. */
export async function POST(req: NextRequest): Promise<Response> {
  try {
    await requireAdminApi();
    const parsed = BodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new AppError("invalid_input", "Email required.");
    await addAllowlistEmail(parsed.data.email);
    return Response.json({ ok: true, emails: await getAllowlist() });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Remove an email from the member allowlist. */
export async function DELETE(req: NextRequest): Promise<Response> {
  try {
    await requireAdminApi();
    const parsed = BodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new AppError("invalid_input", "Email required.");
    await removeAllowlistEmail(parsed.data.email);
    return Response.json({ ok: true, emails: await getAllowlist() });
  } catch (err) {
    return errorResponse(err);
  }
}
