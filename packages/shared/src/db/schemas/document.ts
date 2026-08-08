import { z } from "zod";
import { zObjectId } from "./common";

/**
 * An uploaded file. `status` tracks the ingestion pipeline
 * (uploaded -> parsed -> embedded, or failed). `conversationId` is null when a
 * document is attached to the user's library rather than to one conversation.
 * The raw bytes live in Vercel Blob; `blobUrl` points at them.
 *
 * Images (Phase 12) are the one kind that never walks that pipeline. They are
 * created directly as "ready" and skip parse and embed entirely: an image has no
 * text to chunk, and OCR would discard the layout that made looking at the image
 * worth doing. They therefore have no chunks and are never retrievable — an image
 * reaches the model only by ephemeral hydration into a single turn's request.
 * "ready" is deliberately NOT "embedded", which is precisely what keeps images
 * out of `getRetrievableDocuments` without that query needing to know about them.
 */
export const DocumentSchema = z.object({
  _id: zObjectId.optional(),
  userId: zObjectId,
  filename: z.string(),
  blobUrl: z.string().url(),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  status: z.enum(["uploaded", "parsed", "embedded", "ready", "failed"]),
  conversationId: zObjectId.nullable(),
  createdAt: z.date(),
  // Only present when status is "failed": a short, user-safe reason shown on the
  // document chip with a retry. Omitted otherwise so a successful re-parse leaves
  // no stale error behind.
  failureReason: z.string().optional(),
  // Only present when status is "embedded": how many chunks the file produced.
  // Stored rather than counted because it answers "how much of the per-document
  // chunk budget did this use" without a second query against `chunks`, and it
  // is the number that makes an ingestion failure or a thin extraction legible
  // (a 25MB image-heavy PDF yielding 62 chunks is telling you something).
  chunkCount: z.number().int().nonnegative().optional(),
});

export type DocumentRecord = z.infer<typeof DocumentSchema>;
