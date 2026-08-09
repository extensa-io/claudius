import { getClient, DB_NAME } from "../db/client";

/**
 * Delete every checkpoint belonging to one thread.
 *
 * This is the ONE place in the codebase that writes to `checkpoints` and
 * `checkpoint_writes` directly, against the standing rule that the checkpointer
 * owns those collections. The exception is deliberate and confined here:
 * MongoDBSaver exposes put/get/list but no way to drop a thread, and a "delete
 * conversation" that leaves the entire transcript sitting in the checkpointer
 * is not a delete — it just hides the row that pointed at it. Every other read
 * and write still goes through the saver.
 *
 * The thread id IS the conversation `_id` string, so callers must have verified
 * ownership of that conversation first: this function has no user scope of its
 * own and will delete whatever thread it is handed.
 */
export async function deleteThreadCheckpoints(
  threadId: string,
): Promise<void> {
  const client = await getClient();
  const db = client.db(DB_NAME);
  // Both collections key on thread_id; the writes collection holds the pending
  // channel writes for a step and would otherwise outlive the checkpoints.
  await Promise.all([
    db.collection("checkpoints").deleteMany({ thread_id: threadId }),
    db.collection("checkpoint_writes").deleteMany({ thread_id: threadId }),
  ]);
}
