import type { NextAuthConfig } from "next-auth";
import Google from "next-auth/providers/google";
import { provisionUser } from "./provision";

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
    async jwt({ token, user }) {
      // `user` is only present on initial sign-in. Resolve + persist role then,
      // and carry it (plus the user id) on the token thereafter.
      if (user?.id) {
        token.uid = user.id;
        token.role = await provisionUser(user.id, user.email);
      }
      return token;
    },
    async session({ session, token }) {
      if (token.role) session.user.role = token.role;
      if (token.uid) session.user.id = token.uid;
      return session;
    },
  },
} satisfies NextAuthConfig;
