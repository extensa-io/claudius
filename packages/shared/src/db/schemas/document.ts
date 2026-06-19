import { z } from "zod";
import { zObjectId } from "./common";

/**
 * An uploaded file. `status` tracks the ingestion pipeline
 * (uploaded -> parsed -> embedded, or failed). `conversationId` is null when a
 * document is attached to the user's library rather than to one conversation.
 * The raw bytes live in Vercel Blob; `blobUrl` points at them.
 */
export const DocumentSchema = z.object({
  _id: zObjectId.optional(),
  userId: zObjectId,
  filename: z.string(),
  blobUrl: z.string().url(),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  status: z.enum(["uploaded", "parsed", "embedded", "failed"]),
  conversationId: zObjectId.nullable(),
  createdAt: z.date(),
});

export type DocumentRecord = z.infer<typeof DocumentSchema>;
