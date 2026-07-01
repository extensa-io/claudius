import { ObjectId } from "mongodb";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { AppError, deleteMemory, editMemory } from "@claudius/shared";
import { auth } from "@/lib/auth";
import { errorResponse } from "@/lib/http";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const PatchSchema = z.object({ content: z.string().trim().min(3).max(500) });

/**
 * Edit a memory's content. `editMemory` re-embeds so the corrected wording stays
 * retrievable, and scopes the update to the owner — a memory that isn't theirs
 * (or is missing) is an indistinguishable 404.
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
      throw new AppError("invalid_input", "Memory content is required.");
    }

    const ok = await editMemory(userId, id, parsed.data.content);
    if (!ok) throw new AppError("not_found", "Memory not found.");
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
