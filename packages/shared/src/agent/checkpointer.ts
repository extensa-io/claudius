import { MongoDBSaver } from "@langchain/langgraph-checkpoint-mongodb";
import { clientPromise, DB_NAME } from "../db/client";

/**
 * The LangGraph checkpointer, backed by the same MongoDB client the rest of the
 * app shares. It persists graph state to the `checkpoints` and
 * `checkpoint_writes` collections (the saver's defaults, which match our data
 * model). The checkpointer *owns* those collections — application code never
 * writes to them directly (CLAUDE.md data-model note).
 *
 * Cached on `globalThis` for the same reason the Mongo client is: one instance
 * across Vercel warm invocations and Next.js hot reloads.
 */
const globalForCheckpointer = globalThis as unknown as {
  _claudiusCheckpointer?: Promise<MongoDBSaver>;
};

async function createCheckpointer(): Promise<MongoDBSaver> {
  const client = await clientPromise;
  return new MongoDBSaver({ client, dbName: DB_NAME });
}

export function getCheckpointer(): Promise<MongoDBSaver> {
  return (globalForCheckpointer._claudiusCheckpointer ??= createCheckpointer());
}
