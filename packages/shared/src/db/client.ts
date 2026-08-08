import { MongoClient, type Db } from "mongodb";
import { env } from "../env";

/**
 * One MongoClient for the entire process.
 *
 * In a serverless runtime (Vercel) each warm invocation reuses the same module
 * scope, and Next.js dev re-evaluates modules on every hot reload. Caching the
 * connection promise on `globalThis` guarantees a single connection pool across
 * both, instead of leaking a new pool per invocation or per reload.
 *
 * The same accessor is handed to the Auth.js MongoDB adapter (see
 * packages/app/lib/mongo.ts) so the adapter and the app share one client.
 */
const globalForMongo = globalThis as unknown as {
  _claudiusMongoClientPromise?: Promise<MongoClient>;
};

const client = new MongoClient(env.MONGODB_URI, {
  // Well under the shortest function timeout, so a genuine outage surfaces as a
  // fast error the route can turn into a user-safe message. The driver's 30s
  // default outlives some invocations entirely, which turns a blip into a
  // timed-out request with nothing useful in the log.
  serverSelectionTimeoutMS: 10_000,
});

/**
 * The connection is established lazily, on first use, and deliberately NOT at
 * module scope.
 *
 * A module-scope `client.connect()` starts a connection during import, in every
 * function that transitively imports this file — including ones that never touch
 * Mongo, like an anonymous render of `/` that pulls this in through the Auth.js
 * adapter. Such a request answers in milliseconds and Vercel then freezes the
 * instance mid-handshake. The driver's server-selection timer runs on wall clock,
 * so it expires across the freeze and rejects a promise nobody is awaiting: an
 * unhandled rejection with no route attached, and no outgoing request ever made.
 *
 * Connecting inside `getClient()` means a connection only ever starts within an
 * invocation that is awaiting it and therefore staying alive for it.
 */
export async function getClient(): Promise<MongoClient> {
  // Under vitest, skip connecting entirely: pure-logic tests import this module
  // transitively but never touch the DB, and connecting to the dummy test URI
  // would fail the run.
  if (process.env.VITEST) return client;

  return (globalForMongo._claudiusMongoClientPromise ??= client
    .connect()
    .catch((err: unknown) => {
      // Never cache a failed connect. The cached promise outlives the request,
      // so a rejection left in place poisons the instance permanently: every
      // later call re-throws the same stale error instead of retrying, long
      // after the cluster is healthy again.
      delete globalForMongo._claudiusMongoClientPromise;
      throw err;
    }));
}

/**
 * The application database is always "claudius" (per the project data model),
 * named explicitly rather than relying on a default path in the connection
 * string. Atlas credentials are scoped to this database.
 */
export const DB_NAME = "claudius";

export async function getDb(): Promise<Db> {
  const connected = await getClient();
  return connected.db(DB_NAME);
}
