import { ObjectId } from "mongodb";
import {
  classifyDocument,
  type DocumentRecord,
  chunksCol,
  documentsCol,
} from "@claudius/shared";

/**
 * All document reads and writes funnel through here, every one of them filtered
 * by `userId` (CLAUDE.md invariant #1: no route or tool may return another
 * user's documents). The owner id is always an explicit argument so filtering is
 * impossible to forget at a call site, exactly as conversations.ts does.
 *
 * Documents are conversation-scoped this phase. A document uploaded before a
 * conversation exists is created with `conversationId: null` ("pending") and
 * associated to the conversation when the first message is sent.
 */

/** A document as the chat UI needs it: status and identity, never the bytes. */
export interface DocumentView {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  status: DocumentRecord["status"];
  failureReason: string | null;
}

export function toDocumentView(doc: DocumentRecord): DocumentView {
  return {
    id: doc._id!.toString(),
    filename: doc.filename,
    mimeType: doc.mimeType,
    sizeBytes: doc.sizeBytes,
    status: doc.status,
    failureReason: doc.failureReason ?? null,
  };
}

/**
 * Record an uploaded file. Called by the client right after the Blob upload
 * resolves. `conversationId` is null for an attachment to a not-yet-created
 * conversation. Returns null if the filename's type is not one we accept (the
 * coarse content-type gate at the Blob token can let octet-stream through).
 */
export async function createDocument(params: {
  userId: ObjectId;
  conversationId: ObjectId | null;
  filename: string;
  blobUrl: string;
  mimeType: string;
  sizeBytes: number;
}): Promise<DocumentRecord | null> {
  const kind = classifyDocument(params.filename);
  if (kind === null) return null;

  const doc: DocumentRecord = {
    userId: params.userId,
    filename: params.filename,
    blobUrl: params.blobUrl,
    mimeType: params.mimeType,
    sizeBytes: params.sizeBytes,
    // An image is born finished (Phase 12). There is no parse and no embed to
    // wait for: it has no text to chunk, so "ready" is its terminal state on
    // creation. Crucially it is NOT "embedded", which is what keeps images out
    // of getRetrievableDocuments without that query needing a special case.
    status: kind === "image" ? "ready" : "uploaded",
    conversationId: params.conversationId,
    createdAt: new Date(),
  };
  const col = await documentsCol();
  const result = await col.insertOne(doc);
  return { ...doc, _id: result.insertedId };
}

/** Load a document only if it belongs to this user; null otherwise (treated as 404). */
export async function getOwnedDocument(
  userId: ObjectId,
  documentId: string,
): Promise<DocumentRecord | null> {
  if (!ObjectId.isValid(documentId)) return null;
  const col = await documentsCol();
  return col.findOne({ _id: new ObjectId(documentId), userId });
}

/** A conversation's documents, oldest first, for chips on resume. */
export async function listConversationDocuments(
  userId: ObjectId,
  conversationId: ObjectId,
): Promise<DocumentView[]> {
  const col = await documentsCol();
  const docs = await col
    .find({ userId, conversationId })
    .sort({ createdAt: 1 })
    .toArray();
  return docs.map(toDocumentView);
}

/**
 * Detach (remove) a document from its conversation: delete the record and its
 * chunks. Documents are conversation-scoped this phase, so detaching is removal.
 * Returns false if the document is missing or not the user's.
 */
export async function deleteDocument(
  userId: ObjectId,
  documentId: string,
): Promise<boolean> {
  if (!ObjectId.isValid(documentId)) return false;
  const _id = new ObjectId(documentId);
  const docs = await documentsCol();
  const deleted = await docs.deleteOne({ _id, userId });
  if (deleted.deletedCount === 0) return false;
  // Chunks carry userId too; scope the cleanup by both for defense in depth.
  const chunks = await chunksCol();
  await chunks.deleteMany({ documentId: _id, userId });
  return true;
}

/**
 * Associate pending (conversationId: null) documents with a conversation when
 * the first message is sent. Only touches the user's own still-unassociated
 * documents, so a stale or forged id from the client can never reattach someone
 * else's document or move one between conversations.
 */
export async function associatePendingDocuments(
  userId: ObjectId,
  conversationId: ObjectId,
  documentIds: string[],
): Promise<void> {
  const ids = documentIds
    .filter((id) => ObjectId.isValid(id))
    .map((id) => new ObjectId(id));
  if (ids.length === 0) return;
  const col = await documentsCol();
  await col.updateMany(
    { _id: { $in: ids }, userId, conversationId: null },
    { $set: { conversationId } },
  );
}

/**
 * A conversation's documents that are ready for retrieval (embedded), with their
 * names. The chat route passes the ids to scope `retrieve_documents` and the
 * names into the system prompt so the model knows files are present.
 *
 * Images are structurally excluded: they are created "ready", never "embedded",
 * and have no chunks to search. So an image is never returned here and therefore
 * never reachable through `retrieve_documents` — the only way an image reaches
 * the model is ephemeral hydration into a single turn.
 */
export async function getRetrievableDocuments(
  userId: ObjectId,
  conversationId: ObjectId,
): Promise<Array<{ id: string; filename: string }>> {
  const col = await documentsCol();
  const docs = await col
    .find(
      { userId, conversationId, status: "embedded" },
      { projection: { _id: 1, filename: 1 } },
    )
    .toArray();
  return docs.map((d) => ({ id: d._id!.toString(), filename: d.filename }));
}
