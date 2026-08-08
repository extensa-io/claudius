import { ObjectId } from "mongodb";
import type { NextAuthConfig } from "next-auth";
import Google from "next-auth/providers/google";
import { loadGuestCircuitBreaker, usersCol } from "@claudius/shared";
import { provisionUser } from "./provision";
import { resolveRole } from "./roles";

/**
 * Auth.js configuration: Google sign-in only (CLAUDE.md: no public
 * registration beyond Google with server-side role assignment), JWT sessions so
 * the resolved role rides in the token. The adapter is attached in index.ts.
 *
 * Google credentials are read from AUTH_GOOGLE_ID / AUTH_GOOGLE_SECRET by
 * convention; our env schema still validates their presence at boot.
 */
export const authConfig = {
  providers: [Google],
  session: { strategy: "jwt" },
  callbacks: {
    async signIn({ user }) {
      // Guest kill switch (Phase 4): when the admin has flipped it, guests are
      // blocked from signing in at all. A user who resolves to member/admin via
      // the allowlist is never affected — only the anonymous guest tier.
      const role = await resolveRole(user.email);
      if (role === "guest") {
        const breaker = await loadGuestCircuitBreaker();
        if (breaker.killSwitch) return false;
      }
      return true;
    },
    async jwt({ token, user }) {
      // `user` is only present on initial sign-in. Resolve + persist role then,
      // and carry it (plus the user id) on the token thereafter.
      if (user?.id) {
        token.uid = user.id;
        token.role = await provisionUser(user.id, user.email);
        token.status = "active";
        return token;
      }
      // On every later request, refresh role + status from the DB so an admin's
      // promote / disable / kill action reflects on the user's next request
      // without a re-login (Phase 4). One indexed _id read per request; the
      // enforcement layer already reads the user fresh, so this only closes the
      // UI/gating gap where the token would otherwise carry a stale role.
      if (token.uid) {
        try {
          const users = await usersCol();
          const current = await users.findOne(
            { _id: new ObjectId(token.uid) },
            { projection: { role: 1, status: 1 } },
          );
          if (current) {
            token.role = current.role;
            token.status = current.status;
          }
        } catch {
          // A failed refresh must not destroy a valid session. Throwing here
          // makes Auth.js discard the token as a JWTSessionError, so a database
          // blip signs the user out of every route at once — including ones
          // that never needed the database. Keep the role and status already on
          // the token instead: they are only the UI/gating hint, and invariant
          // #3 has the enforcement layer read the user fresh before any model
          // call, where an unreachable database fails closed on its own.
        }
      }
      return token;
    },
    async session({ session, token }) {
      if (token.role) session.user.role = token.role;
      if (token.uid) session.user.id = token.uid;
      if (token.status) session.user.status = token.status;
      return session;
    },
  },
} satisfies NextAuthConfig;
