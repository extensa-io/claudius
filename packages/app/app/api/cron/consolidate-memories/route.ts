import type { NextRequest } from "next/server";
import { appEnv } from "@claudius/shared";
import { enqueueAllConsolidation } from "@/lib/memory/consolidate";

// Mongo needs the Node runtime. Enqueue-only, so it's cheap and fits the Hobby
// ceiling even across every eligible user.
export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * The daily memory-consolidation cron (Phase 6). Vercel invokes it on the
 * schedule in vercel.json with `Authorization: Bearer <CRON_SECRET>`, checked so
 * nothing but the scheduler can trigger it. Like the extraction cron it only
 * ENQUEUES: one `memory_consolidation` job per memory-eligible member/admin, and
 * the Railway worker runs the heuristic merge-and-prune pass off Vercel.
 */
export async function GET(req: NextRequest): Promise<Response> {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${appEnv().CRON_SECRET}`) {
    return Response.json({ error: { code: "unauthorized" } }, { status: 401 });
  }

  try {
    const result = await enqueueAllConsolidation();
    return Response.json({ ok: true, ...result });
  } catch (err) {
    console.error(
      "Memory consolidation cron failed:",
      err instanceof Error ? `${err.name}: ${err.message}` : err,
    );
    return Response.json(
      { error: { code: "internal", message: "Cron failed." } },
      { status: 500 },
    );
  }
}
