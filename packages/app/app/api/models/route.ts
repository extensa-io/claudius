import { ObjectId } from "mongodb";
import { getUsableModels } from "@claudius/shared";
import { auth } from "@/lib/auth";
import { errorResponse } from "@/lib/http";

export const runtime = "nodejs";

/**
 * The models this user may select, for the model selector. Resolved server-side
 * from the catalog by role and any per-user allowedModels override, so the UI
 * can only ever offer a model `assertCanInvoke` would accept. Inference profile
 * IDs stay server-side; the client needs only id and display name.
 */
export async function GET(): Promise<Response> {
  try {
    const session = await auth();
    if (!session?.user) {
      return Response.json(
        { error: { code: "unauthorized" } },
        { status: 401 },
      );
    }
    const userId = new ObjectId(session.user.id);
    const models = (await getUsableModels(userId)).map((m) => ({
      id: m.id,
      displayName: m.displayName,
      // Phase 12: lets the composer explain that a model can't read images
      // rather than offering an attach button that would fail server-side.
      supportsImages: m.supportsImages ?? false,
    }));
    return Response.json({ models });
  } catch (err) {
    return errorResponse(err);
  }
}
