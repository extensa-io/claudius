import { MongoDBAdapter } from "@auth/mongodb-adapter";
import NextAuth from "next-auth";
import { clientPromise } from "../mongo";
import { authConfig } from "./config";

/**
 * The full Auth.js instance: the edge-shaped config plus the MongoDB adapter,
 * which persists users/accounts/sessions through the same shared client.
 */
export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: MongoDBAdapter(clientPromise),
  ...authConfig,
});
