import type { NextRequest } from "next/server";
import { z } from "zod";
import {
  AppError,
  loadModelCatalog,
  ModelCatalogEntrySchema,
  updateModelCatalog,
} from "@claudius/shared";
import { requireAdminApi } from "@/lib/auth/admin";
import { errorResponse } from "@/lib/http";

export const runtime = "nodejs";

const BodySchema = z.object({ models: z.array(ModelCatalogEntrySchema) });

export async function GET(): Promise<Response> {
  try {
    await requireAdminApi();
    return Response.json({ models: await loadModelCatalog() });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Replace the model catalog (enable/disable, pricing, per-model roles). */
export async function PUT(req: NextRequest): Promise<Response> {
  try {
    await requireAdminApi();
    const parsed = BodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      throw new AppError("invalid_input", "Invalid model catalog.");
    }
    await updateModelCatalog(parsed.data.models);
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
