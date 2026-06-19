import { bedrockHealthProbe, getDb } from "@claudius/shared";
import { auth } from "@/lib/auth";

/**
 * Protected health check. Any signed-in role may call it. It always pings
 * Atlas; the Bedrock probe is opt-in via ?probe=bedrock because it makes a real
 * (tiny) model call. Internal errors are reduced to a generic message.
 */
export const GET = auth(async (req) => {
  if (!req.auth) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  let atlas: "ok" | "error" = "ok";
  try {
    const db = await getDb();
    await db.command({ ping: 1 });
  } catch {
    atlas = "error";
  }

  const probeBedrock =
    new URL(req.url).searchParams.get("probe") === "bedrock";
  const bedrock = probeBedrock ? await bedrockHealthProbe() : null;

  const ok = atlas === "ok" && (!bedrock || bedrock.ok);
  return Response.json(
    { status: ok ? "ok" : "degraded", atlas, bedrock },
    { status: ok ? 200 : 503 },
  );
});
