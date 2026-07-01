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
 * This same promise is handed to the Auth.js MongoDB adapter (see
 * packages/app/lib/mongo.ts) so the adapter and the app share one client.
 */
const globalForMongo = globalThis as unknown as {
  _claudiusMongoClientPromise?: Promise<MongoClient>;
};

const client = new MongoClient(env.MONGODB_URI);

// Under vitest, skip the eager connect: pure-logic tests import this module
// transitively but never touch the DB, and an eager connect to the dummy test
// URI raises an unhandled DNS rejection that fails the run. Production is
// unchanged — it eagerly connects, warming one pool per process. (The driver
// would auto-connect on first operation regardless.)
export const clientPromise: Promise<MongoClient> =
  globalForMongo._claudiusMongoClientPromise ??
  (globalForMongo._claudiusMongoClientPromise = process.env.VITEST
    ? Promise.resolve(client)
    : client.connect());

/**
 * The application database is always "claudius" (per the project data model),
 * named explicitly rather than relying on a default path in the connection
 * string. Atlas credentials are scoped to this database.
 */
export const DB_NAME = "claudius";

export async function getDb(): Promise<Db> {
  const connected = await clientPromise;
  return connected.db(DB_NAME);
}
