import type { NextRequest } from "next/server";
import { appEnv, resetBreaker } from "@claudius/shared";

export const runtime = "nodejs";

/**
 * Daily guest circuit-breaker reset (Phase 4). Vercel invokes it on the schedule
 * in vercel.json with `Authorization: Bearer <CRON_SECRET>`. It flips a
 * spend-tripped breaker back to "open" so guest access resumes for the new UTC
 * day. It deliberately does NOT touch the manual kill switch — that stays off
 * until an admin turns it back on.
 */
export async function GET(req: NextRequest): Promise<Response> {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${appEnv().CRON_SECRET}`) {
    return Response.json({ error: { code: "unauthorized" } }, { status: 401 });
  }

  try {
    await resetBreaker();
    return Response.json({ ok: true });
  } catch (err) {
    console.error(
      "Breaker reset cron failed:",
      err instanceof Error ? `${err.name}: ${err.message}` : err,
    );
    return Response.json(
      { error: { code: "internal", message: "Cron failed." } },
      { status: 500 },
    );
  }
}
