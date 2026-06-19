import type { Role } from "@claudius/shared";
import type { DefaultSession } from "next-auth";

/**
 * Augment Auth.js types so the resolved role (and user id) are typed on the
 * session and the JWT. These are written server-side in the auth callbacks.
 */
declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      role: Role;
    } & DefaultSession["user"];
  }
}

// JWT lives in @auth/core/jwt; next-auth/jwt only re-exports it, so the
// augmentation must target the real module to merge rather than shadow.
declare module "@auth/core/jwt" {
  interface JWT {
    uid?: string;
    role?: Role;
  }
}
