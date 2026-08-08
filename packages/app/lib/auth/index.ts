import { MongoDBAdapter } from "@auth/mongodb-adapter";
import { DB_NAME } from "@claudius/shared";
import NextAuth from "next-auth";
import { getClient } from "../mongo";
import { authConfig } from "./config";

/**
 * The full Auth.js instance: the edge-shaped config plus the MongoDB adapter,
 * which persists users/accounts/sessions through the same shared client.
 *
 * databaseName is set explicitly because the connection string has no default
 * database; without it the adapter would target "test" (which the Atlas
 * credentials cannot access). It mirrors getDb() so auth and app data share the
 * same "claudius" database.
 */
export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: MongoDBAdapter(getClient, { databaseName: DB_NAME }),
  ...authConfig,
});
