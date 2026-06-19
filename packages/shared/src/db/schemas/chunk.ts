import { z } from "zod";
import { zObjectId } from "./common";

/**
 * One embedded slice of a document. Carries `userId` directly (denormalized
 * from its parent document) so vector search can pre-filter by owner without a
 * join, and `documentId` so retrieval can be scoped to a single document. Both
 * are filter fields on the vector index.
 */
export const ChunkSchema = z.object({
  _id: zObjectId.optional(),
  documentId: zObjectId,
  userId: zObjectId,
  text: z.string(),
  embedding: z.array(z.number()),
  pageOrSection: z.string().nullable(),
});

export type Chunk = z.infer<typeof ChunkSchema>;
