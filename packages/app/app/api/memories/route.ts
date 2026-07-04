import { ObjectId } from "mongodb";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { type MemorySort, listMemories } from "@claudius/shared";
import { auth } from "@/lib/auth";
import { errorResponse } from "@/lib/http";

export const runtime = "nodejs";

const QuerySchema = z.object({
  category: z.enum(["fact", "preference", "context"]).optional(),
  sort: z.enum(["newest", "oldest", "last_used", "important"]).optional(),
  q: z.string().max(200).optional(),
});

/**
 * List the signed-in user's active memories for the /memories page. Filtering,
 * sort, and substring search are all applied server-side, scoped to the owner
 * (invariant #1). Superseded memories never appear here — only in a card's
 * expandable supersession history.
 */
export async function GET(req: NextRequest): Promise<Response> {
  try {
    const session = await auth();
    if (!session?.user) {
      return Response.json({ error: { code: "unauthorized" } }, { status: 401 });
    }
    const userId = new ObjectId(session.user.id);

    const url = new URL(req.url);
    const parsed = QuerySchema.safeParse({
      category: url.searchParams.get("category") ?? undefined,
      sort: url.searchParams.get("sort") ?? undefined,
      q: url.searchParams.get("q") ?? undefined,
    });
    if (!parsed.success) {
      return Response.json({ memories: [] });
    }

    const memories = await listMemories(userId, {
      ...(parsed.data.category ? { category: parsed.data.category } : {}),
      ...(parsed.data.sort ? { sort: parsed.data.sort as MemorySort } : {}),
      ...(parsed.data.q ? { search: parsed.data.q } : {}),
    });
    return Response.json({ memories });
  } catch (err) {
    return errorResponse(err);
  }
}
