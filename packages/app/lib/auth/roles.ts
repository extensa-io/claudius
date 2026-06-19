import { env, settingsCol, type Role } from "@claudius/shared";

/**
 * Resolves a user's role server-side, the only place role is ever decided
 * (invariant: the client never supplies role or tier). Precedence:
 *
 *   1. the bootstrap admin email  -> admin
 *   2. an email on the settings allowlist -> member
 *   3. everyone else -> guest
 *
 * Called from the Auth.js jwt callback on sign-in. A missing email defaults to
 * guest, the least-privileged role.
 */
export async function resolveRole(email: string | null | undefined): Promise<Role> {
  if (!email) return "guest";

  const normalized = email.toLowerCase();
  if (normalized === env.ADMIN_EMAIL.toLowerCase()) return "admin";

  const settings = await settingsCol();
  const allowlist = await settings.findOne({ _id: "allowlist" });
  if (allowlist && "emails" in allowlist) {
    const allowed = allowlist.emails.some((e) => e.toLowerCase() === normalized);
    if (allowed) return "member";
  }

  return "guest";
}
