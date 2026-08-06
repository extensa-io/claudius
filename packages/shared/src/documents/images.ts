import { get } from "@vercel/blob";
import { ObjectId } from "mongodb";
import { documentsCol } from "../db/collections";
import { appEnv } from "../env";
import { AppError } from "../errors";
import {
  IMAGE_MIME_BY_EXTENSION,
  MAX_DOCUMENT_BYTES,
  sniffImageMime,
} from "./constants";

/**
 * Image attachments (Phase 12).
 *
 * Images are not documents. A document is ingested once, chunked, embedded, and
 * then retrieved on demand by `retrieve_documents` — an indirection that exists
 * precisely so large text never sits in conversation state. An image cannot take
 * that route: it cannot be chunked, and embedding it would need OCR, which
 * discards exactly the layout that made looking at the image worth doing.
 *
 * So images take the other route: straight into the model request as image
 * content blocks, once, on the turn they are attached. This module owns the two
 * halves of that — resolving which images a turn may use (ownership + policy),
 * and fetching their bytes at invoke time.
 */

/** An image resolved for a turn: enough to hydrate it, nothing more. */
export interface TurnImage {
  id: string;
  filename: string;
  mimeType: string;
  /**
   * Carried from the ownership-filtered read so hydration never has to re-query
   * for it. That matters beyond efficiency: a second lookup by id alone would be
   * a query on user-owned data without a `userId` filter (invariant #1), and the
   * safest way not to write that query is not to need it.
   */
  blobUrl: string;
}

/** An image with its bytes, ready to become a content block. */
export interface HydratedImage extends TurnImage {
  base64: string;
}

/**
 * Resolve the images a turn may send, filtered by owner. Every id must belong to
 * this user AND be an image record in `ready` state; anything else is dropped
 * rather than errored, because a stale id from a re-sent client payload is not
 * worth failing a turn over. Ownership filtering is at the query layer, per
 * invariant #1.
 *
 * Returns them in the order the client asked for, so the model sees "the first
 * image" as the user's first image.
 */
export async function resolveTurnImages(
  userId: ObjectId,
  imageIds: string[],
): Promise<TurnImage[]> {
  const ids = imageIds
    .filter((id) => ObjectId.isValid(id))
    .map((id) => new ObjectId(id));
  if (ids.length === 0) return [];

  const col = await documentsCol();
  const docs = await col
    .find(
      { _id: { $in: ids }, userId, status: "ready" },
      { projection: { _id: 1, filename: 1, mimeType: 1, blobUrl: 1 } },
    )
    .toArray();

  // Only types Bedrock accepts natively survive. The upload path already
  // enforces this, but the record could predate a change to that list.
  const byId = new Map(
    docs
      .filter((d) => isSupportedImageMime(d.mimeType))
      .map((d) => [d._id!.toString(), d]),
  );

  return imageIds.flatMap((id) => {
    const doc = byId.get(id);
    return doc
      ? [
          {
            id,
            filename: doc.filename,
            mimeType: doc.mimeType,
            blobUrl: doc.blobUrl,
          },
        ]
      : [];
  });
}

function isSupportedImageMime(mimeType: string): boolean {
  return Object.values(IMAGE_MIME_BY_EXTENSION).includes(mimeType);
}


/**
 * Fetch the bytes for a turn's images from Blob, base64-encoded for the content
 * block. Reads happen at invoke time and the result is deliberately never
 * stored: the whole point of the design is that these bytes exist only for the
 * duration of one model request.
 *
 * A failure here throws a user-safe AppError rather than silently dropping the
 * image. Dropping it would produce the worst outcome available: the model
 * answers confidently about an image it never received.
 */
export async function hydrateTurnImages(
  images: TurnImage[],
): Promise<HydratedImage[]> {
  if (images.length === 0) return [];
  const token = appEnv().BLOB_READ_WRITE_TOKEN;

  return Promise.all(
    images.map(async (image) => {
      let base64: string;
      let mimeType = image.mimeType;
      try {
        // Private store, so the URL is not publicly fetchable — read it with the
        // SDK's authenticated get(), exactly as the parse pipeline does.
        const result = await get(image.blobUrl, { access: "private", token });
        if (!result?.stream) throw new Error("no stream");
        const bytes = await new Response(result.stream).arrayBuffer();
        if (bytes.byteLength > MAX_DOCUMENT_BYTES) {
          throw new Error("image exceeds the upload limit");
        }
        const actual = sniffImageMime(new Uint8Array(bytes.slice(0, 12)));
        if (actual && actual !== mimeType) mimeType = actual;
        base64 = Buffer.from(bytes).toString("base64");
      } catch (err) {
        console.error(
          `Image hydration failed (id=${image.id}):`,
          err instanceof Error ? `${err.name}: ${err.message}` : err,
        );
        throw new AppError(
          "internal",
          `Could not read the attached image "${image.filename}". Try attaching it again.`,
        );
      }
      return { ...image, mimeType, base64 };
    }),
  );
}
