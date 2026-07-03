import type { NextRequest } from "next/server";
import { appEnv } from "@claudius/shared";
import { enqueueAllStale } from "@/lib/memory/enqueue";

// Mongo needs the Node runtime. maxDuration is the Hobby ceiling; this route only
// enqueues jobs now (Phase 5), which is cheap, so the batch can be large.
export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * The daily memory-extraction cron. Vercel invokes it on the schedule in
 * vercel.json and sends `Authorization: Bearer <CRON_SECRET>`, which we check so
 * nothing but the scheduler can trigger it. From Phase 5 it no longer runs
 * extraction — it ENQUEUES a `memory_extraction` job per stale conversation, and
 * the Railway worker does the model work off Vercel entirely.
 */
export async function GET(req: NextRequest): Promise<Response> {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${appEnv().CRON_SECRET}`) {
    return Response.json({ error: { code: "unauthorized" } }, { status: 401 });
  }

  try {
    const result = await enqueueAllStale();
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
