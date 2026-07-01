import { ObjectId } from "mongodb";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { AppError, setMemoryEnabled } from "@claudius/shared";
import { auth } from "@/lib/auth";
import { errorResponse } from "@/lib/http";

export const runtime = "nodejs";

const PatchSchema = z.object({ enabled: z.boolean() });

/**
 * Flip the memory master switch. When disabled, `load_context` retrieves nothing
 * and the extraction triggers skip this user entirely — memory is fully off.
 */
export async function PATCH(req: NextRequest): Promise<Response> {
  try {
    const session = await auth();
    if (!session?.user) {
      return Response.json({ error: { code: "unauthorized" } }, { status: 401 });
    }
    const userId = new ObjectId(session.user.id);

    const parsed = PatchSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      throw new AppError("invalid_input", "Invalid setting.");
    }

    await setMemoryEnabled(userId, parsed.data.enabled);
    return Response.json({ ok: true, enabled: parsed.data.enabled });
  } catch (err) {
    return errorResponse(err);
  }
}
