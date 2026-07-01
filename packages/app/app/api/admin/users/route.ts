import { listUsersWithUsage } from "@claudius/shared";
import { requireAdminApi } from "@/lib/auth/admin";
import { errorResponse } from "@/lib/http";

export const runtime = "nodejs";

/** Admin: list all users with role, status, and current-month usage. */
export async function GET(): Promise<Response> {
  try {
    await requireAdminApi();
    const users = await listUsersWithUsage();
    return Response.json({ users });
  } catch (err) {
    return errorResponse(err);
  }
}
