import { notFound } from "next/navigation";
import type { Session } from "next-auth";
import { AppError } from "@claudius/shared";
import { auth } from "./index";

/**
 * Admin gate (invariant #6: admin is settings/users/aggregate-usage only). Two
 * flavors, one rule — the caller must be signed in AND have role admin.
 *
 * Non-admins get a 404, not a 403: the admin surface shouldn't even confirm it
 * exists to a member or guest. Unauthenticated callers get a 401 so a signed-out
 * client can tell it needs to sign in.
 */

/** For admin API route handlers. Throws AppError; wrap in try/catch + errorResponse. */
export async function requireAdminApi(): Promise<Session> {
  const session = await auth();
  if (!session?.user) {
    throw new AppError("unauthorized", "Sign in required.");
  }
  if (session.user.role !== "admin") {
    throw new AppError("not_found", "Not found.");
  }
  return session;
}

/** For admin server components. Renders the 404 page for anyone who isn't admin. */
export async function requireAdminPage(): Promise<Session> {
  const session = await auth();
  if (session?.user?.role !== "admin") notFound();
  return session;
}
