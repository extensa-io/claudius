"use client";

import { upload } from "@vercel/blob/client";
import {
  extensionOf,
  messageOf,
  reportClientError,
  sizeBucketOf,
} from "@/lib/report-error";
// Deep import (see composer.tsx): the barrel is not client-safe.
import {
  classifyDocument,
  MAX_DOCUMENT_BYTES,
  sniffImageMime,
  uploadContentTypeFor,
} from "@claudius/shared/documents/constants";
import { useCallback, useEffect, useRef, useState } from "react";
import type { DocumentView, ImagePolicyView } from "@/lib/chat/view-types";

/**
 * Client state for a conversation's attached documents: the upload → parse →
 * embed lifecycle, retry, and detach. It owns the document chips shown in the
 * composer and the list of "pending" ids (uploaded before the conversation
 * existed) that the next message must carry so the server can associate them.
 *
 * Bytes go straight from the browser to Vercel Blob via `upload()`; the DB
 * record and parsing are two short follow-up calls. We never proxy file bytes
 * through our own API (4.5MB route-body limit).
 */

/** Chip status, a superset of the server status with two client-only phases.
 * "ready" is the image terminal state — no parse, no embed (Phase 12). */
export type ChipStatus =
  | "uploading"
  | "uploaded"
  | "parsing"
  | "parsed"
  | "embedded"
  | "ready"
  | "failed";

export interface DocChip {
  /** Real document id once created; a temporary "tmp-N" id while uploading. */
  id: string;
  filename: string;
  status: ChipStatus;
  /** 0–100 during the upload phase. */
  percentage?: number;
  failureReason?: string | null;
  /** Images render as a thumbnail and ride the turn rather than the retrieval
   * pipeline, so the chip has to know which kind it is. */
  isImage?: boolean;
  /** Object URL of the local file, for the thumbnail. Images only, and only for
   * the session that uploaded them — the blob itself is private and not
   * fetchable by URL, and it is deliberately not proxied back for a preview. */
  previewUrl?: string;
}

/**
 * Downscale an image so its long edge is at most `maxLongEdgePx`, returning the
 * original untouched when it already fits (or when anything goes wrong — a
 * failed resize must not cost the user their attachment).
 *
 * This happens BEFORE upload on purpose. Resizing server-side would mean the
 * full-size bytes still crossed the wire and still occupied Blob storage; doing
 * it here means the oversized pixels never exist anywhere but the user's own
 * machine. The output is JPEG for photographs and PNG for anything with
 * transparency, since flattening a screenshot's alpha channel to black is a
 * worse outcome than a slightly larger file.
 */
/**
 * The upload content type for a file, preferring what its first bytes say over
 * what its extension claims. Extensions lie — a WebP downloaded as `.jpg` is
 * ordinary on the open web — and the stored type has to match the bytes, since
 * Bedrock cross-checks the two and rejects the mismatch. Non-images and
 * unrecognised magic bytes fall back to the extension mapping.
 */
/**
 * The over-the-limit message for a file, or null if it fits.
 *
 * Blob enforces the same cap at the far end, but only once the upload is under
 * way, and it answers with its own byte count ("cannot be greater than 20971520
 * bytes") which tells the user nothing they can act on. Checking here costs
 * nothing and lets us say which file, how big it is, and what the limit is.
 */
function overSizeLimit(bytes: number): string | null {
  if (bytes <= MAX_DOCUMENT_BYTES) return null;
  const mb = (n: number): string => `${Math.round(n / (1024 * 1024))}MB`;
  return `This file is ${mb(bytes)}. The limit is ${mb(MAX_DOCUMENT_BYTES)}.`;
}

async function trueContentTypeFor(file: File): Promise<string> {
  const byExtension = uploadContentTypeFor(file.name);
  if (classifyDocument(file.name) !== "image") return byExtension;
  try {
    const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    return sniffImageMime(head) ?? byExtension;
  } catch {
    return byExtension;
  }
}

async function downscaleImage(
  file: File,
  maxLongEdgePx: number,
  sourceType: string,
): Promise<File> {
  try {
    const bitmap = await createImageBitmap(file);
    const longEdge = Math.max(bitmap.width, bitmap.height);
    if (longEdge <= maxLongEdgePx) {
      bitmap.close();
      return file;
    }
    const scale = maxLongEdgePx / longEdge;
    const width = Math.round(bitmap.width * scale);
    const height = Math.round(bitmap.height * scale);

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();

    // Sniffed, not `file.type`: the browser derives that from the extension
    // too, so a WebP named .jpg would lose its alpha channel to a JPEG re-encode.
    const keepAlpha = sourceType === "image/png" || sourceType === "image/webp";
    const outType = keepAlpha ? "image/png" : "image/jpeg";
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, outType, 0.9),
    );
    if (!blob) return file;

    // Keep the base name so the chip and the persisted turn still name the file
    // the user recognises; only the extension follows the re-encode.
    const base = file.name.replace(/\.[^.]+$/, "");
    const ext = outType === "image/png" ? "png" : "jpg";
    return new File([blob], `${base}.${ext}`, { type: outType });
  } catch {
    return file;
  }
}

/** ".JPG" → "JPG files", for a rejection message that names what was picked. */
function extensionLabel(filename: string): string | null {
  const dot = filename.lastIndexOf(".");
  if (dot === -1 || dot === filename.length - 1) return null;
  return `${filename.slice(dot + 1).toUpperCase()} files`;
}

function toChip(doc: DocumentView): DocChip {
  return {
    id: doc.id,
    filename: doc.filename,
    status: doc.status,
    failureReason: doc.failureReason,
  };
}

export interface UseDocuments {
  chips: DocChip[];
  /** Real ids of documents uploaded before the conversation existed. */
  pendingDocumentIds: string[];
  hasReadyDocuments: boolean;
  /** Ids of images attached to the NEXT turn, in attach order (Phase 12). */
  attachedImageIds: string[];
  /** True when the attached image count is over the tier cap. Under "hard"
   * enforcement the composer blocks send; under "warn" it shows the cost and
   * lets the turn through. */
  overImageCap: boolean;
  uploadFiles: (files: FileList | File[]) => void;
  retry: (id: string) => void;
  remove: (id: string) => void;
  /** Clear pending ids after a turn associates them server-side. */
  clearPending: () => void;
  /** Drop the image chips after a turn has sent them. Images live for exactly
   * one turn, so leaving the chips up would imply they are still attached. */
  clearImages: () => void;
}

export function useDocuments({
  conversationId,
  initialDocuments,
  imagePolicy,
}: {
  conversationId: string | null;
  initialDocuments: DocumentView[];
  imagePolicy: ImagePolicyView | null;
}): UseDocuments {
  const [chips, setChips] = useState<DocChip[]>(() =>
    initialDocuments.map(toChip),
  );
  const [pendingIds, setPendingIds] = useState<string[]>([]);

  // Read the latest conversation id at upload time without re-creating callbacks
  // (the id changes from null to a real id when the first message creates it).
  const convIdRef = useRef(conversationId);
  useEffect(() => {
    convIdRef.current = conversationId;
  }, [conversationId]);

  const tmpCounter = useRef(0);

  const patch = useCallback((id: string, next: Partial<DocChip>): void => {
    setChips((prev) =>
      prev.map((c) => (c.id === id ? { ...c, ...next } : c)),
    );
  }, []);

  // The images this turn will send: real ids only, in attach order. Held in a
  // ref as well so uploadFiles can count them without re-creating the callback
  // on every chip change.
  const attachedImageIds = chips
    .filter((c) => c.isImage && c.status === "ready")
    .map((c) => c.id);
  const attachedImageIdsRef = useRef<string[]>(attachedImageIds);
  attachedImageIdsRef.current = attachedImageIds;

  // Run the parse pipeline for a created document and reflect the final status.
  const runParse = useCallback(
    async (id: string): Promise<void> => {
      patch(id, { status: "parsing", failureReason: null });
      try {
        const res = await fetch(`/api/documents/${id}/parse`, {
          method: "POST",
        });
        if (!res.ok) {
          // A 504 means the parse exceeded the function time limit (the file is
          // too big to process on the current plan); otherwise surface the
          // server's user-safe message if it sent one.
          if (res.status === 504) {
            patch(id, {
              status: "failed",
              failureReason:
                "This file took too long to process on the current plan. Try a smaller file.",
            });
            return;
          }
          const body = (await res.json().catch(() => null)) as {
            error?: { message?: string };
          } | null;
          throw new Error(body?.error?.message ?? "Processing failed.");
        }
        const data = (await res.json()) as { document: DocumentView };
        patch(id, {
          status: data.document.status,
          failureReason: data.document.failureReason,
        });
      } catch (err) {
        patch(id, {
          status: "failed",
          failureReason:
            err instanceof Error ? err.message : "Could not process this file.",
        });
      }
    },
    [patch],
  );

  const uploadOne = useCallback(
    async (file: File): Promise<void> => {
      const tmpId = `tmp-${tmpCounter.current++}`;
      const isImage = classifyDocument(file.name) === "image";
      setChips((prev) => [
        ...prev,
        {
          id: tmpId,
          filename: file.name,
          status: "uploading",
          percentage: 0,
          isImage,
          ...(isImage ? { previewUrl: URL.createObjectURL(file) } : {}),
        },
      ]);

      // Reject unsupported types *before* spending an upload on them. Without
      // this the bytes land in Blob, the create-record call rejects the
      // extension, and the user watches a progress bar reach 100% only to fail —
      // leaving an orphaned blob with no record to retry or clean up against.
      if (classifyDocument(file.name) === null) {
        patch(tmpId, {
          status: "failed",
          failureReason: `${
            extensionLabel(file.name) ?? "This file type"
          } isn't supported. Attach a PDF, Word document, image, or text/code file.`,
        });
        return;
      }

      // Size is checked here for anything that isn't an image, and again after
      // the resize for images: an oversized photo is usually well under the cap
      // once downscaled, so refusing it on its original size would reject files
      // that were always going to be fine.
      if (!isImage) {
        const tooLarge = overSizeLimit(file.size);
        if (tooLarge) {
          patch(tmpId, { status: "failed", failureReason: tooLarge });
          return;
        }
      }

      // Guard the picker's accept filter with a policy check: an image dragged
      // in on a role with no image service (or with the policy absent) is
      // refused here rather than at the far end of an upload.
      if (isImage && !imagePolicy) {
        patch(tmpId, {
          status: "failed",
          failureReason: "Image attachments aren't available on your plan.",
        });
        return;
      }

      try {
        // Downscale to the tier's long-edge target BEFORE upload, so the
        // oversized bytes never occupy Blob storage or request bandwidth.
        const sourceType = await trueContentTypeFor(file);
        const toUpload =
          isImage && imagePolicy
            ? await downscaleImage(file, imagePolicy.maxLongEdgePx, sourceType)
            : file;
        // A re-encode produced its own honest type; an untouched file keeps the
        // sniffed one. Either way the declared type matches the stored bytes.
        const contentType =
          toUpload === file ? sourceType : uploadContentTypeFor(toUpload.name);

        // An image that is still over the cap after downscaling (or that failed
        // to resize at all) is refused here, before any bytes are sent.
        const tooLarge = overSizeLimit(toUpload.size);
        if (tooLarge) {
          patch(tmpId, { status: "failed", failureReason: tooLarge });
          return;
        }

        const blob = await upload(toUpload.name, toUpload, {
          // Private store: documents must not be publicly fetchable by URL. The
          // parse pipeline reads them server-side with the SDK's authenticated get().
          access: "private",
          handleUploadUrl: "/api/blob/upload",
          contentType,
          onUploadProgress: ({ percentage }) =>
            patch(tmpId, { percentage }),
        });

        // Create the DB record (single creation path; see the upload route).
        const res = await fetch("/api/documents", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            conversationId: convIdRef.current,
            blobUrl: blob.url,
            filename: toUpload.name,
            mimeType: blob.contentType,
            sizeBytes: toUpload.size,
          }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as {
            error?: { message?: string };
          } | null;
          throw new Error(body?.error?.message ?? "Could not save the file.");
        }
        const { document } = (await res.json()) as { document: DocumentView };

        // Swap the temp chip for the real one, keeping the local preview: the
        // blob is private, so the object URL from this session is the only
        // thumbnail source we have.
        setChips((prev) =>
          prev.map((c) =>
            c.id === tmpId
              ? {
                  ...toChip(document),
                  ...(c.isImage !== undefined ? { isImage: c.isImage } : {}),
                  ...(c.previewUrl !== undefined
                    ? { previewUrl: c.previewUrl }
                    : {}),
                }
              : c,
          ),
        );
        // Uploaded before the conversation existed → must be associated on send.
        // Images are excluded: association is what makes a document part of the
        // conversation for the rest of its life, which is exactly the lifetime an
        // image must not have. An image stays unassociated and is referenced by
        // id for one turn only.
        if (convIdRef.current === null && !isImage) {
          setPendingIds((prev) => [...prev, document.id]);
        }

        // Images skip parse entirely — they are created "ready" and have no text
        // to chunk or embed (Phase 12).
        if (!isImage) await runParse(document.id);
      } catch (err) {
        // The upload runs entirely in the browser, so without this the failure
        // leaves no trace on the server at all — see /api/client-errors.
        reportClientError({
          stage: "upload",
          message: messageOf(err),
          extension: extensionOf(file.name),
          sizeBucket: sizeBucketOf(file.size),
          stack: err instanceof Error ? (err.stack ?? null) : null,
        });
        patch(tmpId, {
          status: "failed",
          failureReason: err instanceof Error ? err.message : "Upload failed.",
        });
      }
    },
    [patch, runParse, imagePolicy],
  );

  const uploadFiles = useCallback(
    (files: FileList | File[]): void => {
      const incoming = Array.from(files);
      let imagesSoFar = attachedImageIdsRef.current.length;
      for (const file of incoming) {
        // A HARD cap is refused before the upload is spent, which is the whole
        // point of checking client-side: the bytes never leave the machine. A
        // WARN cap uploads and lets the composer show the cost instead.
        if (
          classifyDocument(file.name) === "image" &&
          imagePolicy?.enforcement === "hard" &&
          imagesSoFar >= imagePolicy.maxPerTurn
        ) {
          const tmpId = `tmp-${tmpCounter.current++}`;
          setChips((prev) => [
            ...prev,
            {
              id: tmpId,
              filename: file.name,
              status: "failed",
              isImage: true,
              failureReason: `You can attach up to ${imagePolicy.maxPerTurn} image${
                imagePolicy.maxPerTurn === 1 ? "" : "s"
              } per message.`,
            },
          ]);
          continue;
        }
        if (classifyDocument(file.name) === "image") imagesSoFar += 1;
        void uploadOne(file);
      }
    },
    [uploadOne, imagePolicy],
  );

  const retry = useCallback(
    (id: string): void => {
      // A temp (never-created) chip can't be re-parsed; drop it so the user can
      // re-pick the file. A real document re-runs the pipeline.
      if (id.startsWith("tmp-")) {
        setChips((prev) => prev.filter((c) => c.id !== id));
        return;
      }
      void runParse(id);
    },
    [runParse],
  );

  const remove = useCallback((id: string): void => {
    setChips((prev) => prev.filter((c) => c.id !== id));
    setPendingIds((prev) => prev.filter((p) => p !== id));
    if (!id.startsWith("tmp-")) {
      void fetch(`/api/documents/${id}`, { method: "DELETE" });
    }
  }, []);

  const clearPending = useCallback(() => setPendingIds([]), []);

  const clearImages = useCallback(() => {
    setChips((prev) => {
      for (const c of prev) {
        if (c.isImage && c.previewUrl) URL.revokeObjectURL(c.previewUrl);
      }
      return prev.filter((c) => !c.isImage);
    });
  }, []);

  return {
    chips,
    pendingDocumentIds: pendingIds,
    hasReadyDocuments: chips.some((c) => c.status === "embedded"),
    attachedImageIds,
    overImageCap:
      imagePolicy !== null && attachedImageIds.length > imagePolicy.maxPerTurn,
    uploadFiles,
    retry,
    remove,
    clearPending,
    clearImages,
  };
}
