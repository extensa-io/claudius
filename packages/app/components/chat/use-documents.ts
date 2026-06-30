"use client";

import { upload } from "@vercel/blob/client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { DocumentView } from "@/lib/chat/view-types";

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

/** Chip status, a superset of the server status with two client-only phases. */
export type ChipStatus =
  | "uploading"
  | "uploaded"
  | "parsing"
  | "parsed"
  | "embedded"
  | "failed";

export interface DocChip {
  /** Real document id once created; a temporary "tmp-N" id while uploading. */
  id: string;
  filename: string;
  status: ChipStatus;
  /** 0–100 during the upload phase. */
  percentage?: number;
  failureReason?: string | null;
}

/** Force an allowed upload content type from the extension; the server decides
 * parsing by extension regardless, and code/text is re-decoded as UTF-8. */
function contentTypeFor(filename: string): string {
  const ext = filename.slice(filename.lastIndexOf(".") + 1).toLowerCase();
  if (ext === "pdf") return "application/pdf";
  if (ext === "docx") {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  return "text/plain";
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
  uploadFiles: (files: FileList | File[]) => void;
  retry: (id: string) => void;
  remove: (id: string) => void;
  /** Clear pending ids after a turn associates them server-side. */
  clearPending: () => void;
}

export function useDocuments({
  conversationId,
  initialDocuments,
}: {
  conversationId: string | null;
  initialDocuments: DocumentView[];
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
      setChips((prev) => [
        ...prev,
        { id: tmpId, filename: file.name, status: "uploading", percentage: 0 },
      ]);

      try {
        const blob = await upload(file.name, file, {
          access: "public",
          handleUploadUrl: "/api/blob/upload",
          contentType: contentTypeFor(file.name),
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
            filename: file.name,
            mimeType: blob.contentType,
            sizeBytes: file.size,
          }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as {
            error?: { message?: string };
          } | null;
          throw new Error(body?.error?.message ?? "Could not save the file.");
        }
        const { document } = (await res.json()) as { document: DocumentView };

        // Swap the temp chip for the real one.
        setChips((prev) =>
          prev.map((c) => (c.id === tmpId ? toChip(document) : c)),
        );
        // Uploaded before the conversation existed → must be associated on send.
        if (convIdRef.current === null) {
          setPendingIds((prev) => [...prev, document.id]);
        }

        await runParse(document.id);
      } catch (err) {
        patch(tmpId, {
          status: "failed",
          failureReason:
            err instanceof Error ? err.message : "Upload failed.",
        });
      }
    },
    [patch, runParse],
  );

  const uploadFiles = useCallback(
    (files: FileList | File[]): void => {
      for (const file of Array.from(files)) void uploadOne(file);
    },
    [uploadOne],
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

  return {
    chips,
    pendingDocumentIds: pendingIds,
    hasReadyDocuments: chips.some((c) => c.status === "embedded"),
    uploadFiles,
    retry,
    remove,
    clearPending,
  };
}
