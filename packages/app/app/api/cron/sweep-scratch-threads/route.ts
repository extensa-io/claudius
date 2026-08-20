import type { NextRequest } from "next/server";
import { appEnv } from "@claudius/shared";
import { sweepScratchThreads } from "@/lib/chat/conversations";

export const runtime = "nodejs";

/**
 * Hourly sweep of lapsed scratch threads: the throwaway conversations created by
 * `?word`, `$SYMBOL` and `&lang` lookups that never became real chats. Vercel
 * invokes it on the schedule in vercel.json with
 * `Authorization: Bearer <CRON_SECRET>`.
 *
 * Hourly rather than daily for a specific reason: a guest's scratch thread also
 * carries `expiresAt`, and that field IS under a TTL index. Whichever reaper
 * arrives first wins, and only this one runs the cascade that clears the
 * thread's checkpoints, so it should almost always be this one.
 */
export async function GET(req: NextRequest): Promise<Response> {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${appEnv().CRON_SECRET}`) {
    return Response.json({ error: { code: "unauthorized" } }, { status: 401 });
  }

  try {
    const { deleted, failed } = await sweepScratchThreads();
    return Response.json({ ok: true, deleted, failed });
  } catch (err) {
    console.error(
      "Scratch thread sweep failed:",
      err instanceof Error ? `${err.name}: ${err.message}` : err,
    );
    return Response.json(
      { error: { code: "internal", message: "Cron failed." } },
      { status: 500 },
    );
  }
}
