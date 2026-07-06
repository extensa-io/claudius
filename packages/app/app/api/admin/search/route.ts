import type { NextRequest } from "next/server";
import { z } from "zod";
import {
  AppError,
  BangSchema,
  CacheTtlsSchema,
  DEFAULT_BANGS,
  DEFAULT_CACHE_TTLS,
  DEFAULT_ESCALATION_KEYWORDS,
  loadSearchSettings,
  updateSearchSettings,
} from "@claudius/shared";
import { requireAdminApi } from "@/lib/auth/admin";
import { errorResponse } from "@/lib/http";

export const runtime = "nodejs";

const BodySchema = z.object({
  braveMonthlyThreshold: z.number().int().nonnegative(),
  highValueMinResults: z.number().int().nonnegative(),
  customBangs: z.array(BangSchema),
  escalationKeywords: z.array(z.string().min(1)),
  cacheTtls: CacheTtlsSchema,
});

/**
 * Read the answer-engine search settings for the admin panel. Phase 8 fields are
 * optional on the stored document, so defaults are applied here for display; the
 * read-only Brave monthly counter rides along untouched.
 */
export async function GET(): Promise<Response> {
  try {
    await requireAdminApi();
    const s = await loadSearchSettings();
    return Response.json({
      search: {
        braveMonthlyThreshold: s.braveMonthlyThreshold,
        highValueMinResults: s.highValueMinResults,
        customBangs: s.customBangs ?? DEFAULT_BANGS,
        escalationKeywords: s.escalationKeywords ?? DEFAULT_ESCALATION_KEYWORDS,
        cacheTtls: s.cacheTtls ?? DEFAULT_CACHE_TTLS,
        braveUsage: s.braveUsage, // read-only counter, displayed not edited
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Persist the editable search settings. braveUsage is never written here (the
 * engine owns the counter), so an admin save can't wipe a month's spend guard. */
export async function PUT(req: NextRequest): Promise<Response> {
  try {
    await requireAdminApi();
    const parsed = BodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      throw new AppError("invalid_input", "Invalid search settings.");
    }
    await updateSearchSettings(parsed.data);
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
