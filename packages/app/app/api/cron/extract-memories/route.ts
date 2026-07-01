import type { NextRequest } from "next/server";
import { env } from "@claudius/shared";
import { sweepAllStale } from "@/lib/memory/sweep";

// LangGraph, the checkpointer, and Mongo need the Node runtime. maxDuration is
// the Hobby ceiling; sweepAllStale is bounded to fit inside it.
export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * The daily memory-extraction cron (Phase 3). Vercel invokes it on the schedule
 * in vercel.json and sends `Authorization: Bearer <CRON_SECRET>`, which we check
 * so nothing but the scheduler can trigger a sweep. It processes a bounded batch
 * of conversations that have new turns since their last extraction; the sign-in
 * lazy pass keeps active users fresh between daily runs.
 */
export async function GET(req: NextRequest): Promise<Response> {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${env.CRON_SECRET}`) {
    return Response.json({ error: { code: "unauthorized" } }, { status: 401 });
  }

  try {
    const result = await sweepAllStale();
    return Response.json({ ok: true, ...result });
  } catch (err) {
    console.error(
      "Memory extraction cron failed:",
      err instanceof Error ? `${err.name}: ${err.message}` : err,
    );
    return Response.json(
      { error: { code: "internal", message: "Cron failed." } },
      { status: 500 },
    );
  }
}
