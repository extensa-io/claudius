import type { NextRequest } from "next/server";
import { z } from "zod";
import {
  AppError,
  guestBreakerView,
  resetBreaker,
  setGuestDailyCeiling,
  setGuestKillSwitch,
  tripBreaker,
} from "@claudius/shared";
import { requireAdminApi } from "@/lib/auth/admin";
import { errorResponse } from "@/lib/http";

export const runtime = "nodejs";

// One endpoint, an action discriminator — the panel's controls all map here.
const ActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("trip") }),
  z.object({ action: z.literal("reset") }),
  z.object({ action: z.literal("killSwitch"), on: z.boolean() }),
  z.object({
    action: z.literal("ceiling"),
    usd: z.number().nonnegative(),
  }),
]);

export async function GET(): Promise<Response> {
  try {
    await requireAdminApi();
    return Response.json({ breaker: await guestBreakerView() });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  try {
    await requireAdminApi();
    const parsed = ActionSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      throw new AppError("invalid_input", "Invalid breaker action.");
    }
    const body = parsed.data;
    switch (body.action) {
      case "trip":
        await tripBreaker();
        break;
      case "reset":
        await resetBreaker();
        break;
      case "killSwitch":
        await setGuestKillSwitch(body.on);
        break;
      case "ceiling":
        await setGuestDailyCeiling(body.usd);
        break;
    }
    return Response.json({ ok: true, breaker: await guestBreakerView() });
  } catch (err) {
    return errorResponse(err);
  }
}
