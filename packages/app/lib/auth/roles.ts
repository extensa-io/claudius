import { appEnv, settingsCol, type Role } from "@claudius/shared";

/**
 * Resolves a user's role server-side, the only place role is ever decided
 * (invariant: the client never supplies role or tier). Precedence, highest first:
 *
 *   1. the bootstrap ADMIN_EMAIL env var -> admin (non-revocable; env wins)
 *   2. an email on the settings adminAllowlist -> admin (revocable extra admins)
 *   3. an email on the settings member allowlist -> member
 *   4. everyone else -> guest
 *
 * Called from the Auth.js jwt callback on sign-in. A missing email defaults to
 * guest, the least-privileged role. The two allowlists are read in one query.
 */
export async function resolveRole(email: string | null | undefined): Promise<Role> {
  if (!email) return "guest";

  const normalized = email.toLowerCase();
  // 1. Env admin outranks everything and cannot be revoked via a list.
  if (normalized === appEnv().ADMIN_EMAIL.toLowerCase()) return "admin";

  const settings = await settingsCol();
  const [adminList, memberList] = await Promise.all([
    settings.findOne({ _id: "adminAllowlist" }),
    settings.findOne({ _id: "allowlist" }),
  ]);

  // 2. Admin allowlist outranks the member allowlist (an email on both is admin).
  if (adminList && "emails" in adminList) {
    if (adminList.emails.some((e) => e.toLowerCase() === normalized)) {
      return "admin";
    }
  }

  // 3. Member allowlist.
  if (memberList && "emails" in memberList) {
    if (memberList.emails.some((e) => e.toLowerCase() === normalized)) {
      return "member";
    }
  }

  return "guest";
}
