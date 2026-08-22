import type { NextRequest } from "next/server";
import { appEnv } from "@claudius/shared";
import { sweepExpiredThreads } from "@/lib/chat/conversations";

export const runtime = "nodejs";

/**
 * Hourly sweep of conversations that have run out of time: lapsed scratch
 * threads (the throwaway conversations created by `?word`, `$SYMBOL` and `&lang`
 * lookups that never became real chats) and guest threads nearing their
 * `expiresAt`. Vercel invokes it on the schedule in vercel.json with
 * `Authorization: Bearer <CRON_SECRET>`.
 *
 * Hourly rather than daily because guest threads carry a TTL index on
 * `expiresAt`, and that reaper deletes the conversation row without the cascade
 * that clears the thread's checkpoints. The sweep is dated to reach those
 * threads an hour before the TTL can, so this run is the one that wins.
 */
export async function GET(req: NextRequest): Promise<Response> {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${appEnv().CRON_SECRET}`) {
    return Response.json({ error: { code: "unauthorized" } }, { status: 401 });
  }

  try {
    const { deleted, failed } = await sweepExpiredThreads();
    return Response.json({ ok: true, deleted, failed });
  } catch (err) {
    console.error(
      "Expiry sweep failed:",
      err instanceof Error ? `${err.name}: ${err.message}` : err,
    );
    return Response.json(
      { error: { code: "internal", message: "Cron failed." } },
      { status: 500 },
    );
  }
}
