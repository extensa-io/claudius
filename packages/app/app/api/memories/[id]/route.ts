import { ObjectId } from "mongodb";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { AppError, deleteMemory, editMemory, setImportance } from "@claudius/shared";
import { auth } from "@/lib/auth";
import { errorResponse } from "@/lib/http";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

// A PATCH sets content (re-embeds) or importance (Phase 6, re-ranks only), or
// both. At least one must be present; keeping them independent means editing
// wording never silently resets salience, and vice versa.
const PatchSchema = z
  .object({
    content: z.string().trim().min(3).max(500).optional(),
    importance: z.number().min(0).max(1).optional(),
  })
  .refine((v) => v.content !== undefined || v.importance !== undefined, {
    message: "Provide content or importance.",
  });

/**
 * Edit a memory. `content` re-embeds so the corrected wording stays retrievable;
 * `importance` only re-ranks (no embedding change). Both scope the update to the
 * owner — a memory that isn't theirs (or is missing) is an indistinguishable 404.
 */
export async function PATCH(
  req: NextRequest,
  ctx: RouteContext,
): Promise<Response> {
  try {
    const session = await auth();
    if (!session?.user) {
      return Response.json({ error: { code: "unauthorized" } }, { status: 401 });
    }
    const userId = new ObjectId(session.user.id);
    const { id } = await ctx.params;

    const parsed = PatchSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      throw new AppError("invalid_input", "Nothing to update.");
    }

    if (parsed.data.content !== undefined) {
      const ok = await editMemory(userId, id, parsed.data.content);
      if (!ok) throw new AppError("not_found", "Memory not found.");
    }
    if (parsed.data.importance !== undefined) {
      const ok = await setImportance(userId, id, parsed.data.importance);
      if (!ok) throw new AppError("not_found", "Memory not found.");
    }
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Delete a memory. Removes it from retrieval immediately; owner-scoped. */
export async function DELETE(
  _req: NextRequest,
  ctx: RouteContext,
): Promise<Response> {
  try {
    const session = await auth();
    if (!session?.user) {
      return Response.json({ error: { code: "unauthorized" } }, { status: 401 });
    }
    const userId = new ObjectId(session.user.id);
    const { id } = await ctx.params;

    const ok = await deleteMemory(userId, id);
    if (!ok) throw new AppError("not_found", "Memory not found.");
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
