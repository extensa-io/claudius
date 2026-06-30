"use client";

import {
  CircleAlert,
  FileText,
  Loader2,
  RefreshCw,
  X,
} from "lucide-react";
import type { ChipStatus, DocChip } from "./use-documents";

/**
 * The attached-document chips shown above the composer. Each chip surfaces where
 * the file is in the upload → parse → embed lifecycle, with a retry on failure
 * and a remove (detach) action. Making ingestion status visible is the point:
 * the user knows when a document is actually ready to be asked about.
 */

const STATUS_LABEL: Record<ChipStatus, string> = {
  uploading: "Uploading",
  uploaded: "Queued",
  parsing: "Processing",
  parsed: "Processing",
  embedded: "Ready",
  failed: "Failed",
};

function StatusIcon({ status }: { status: ChipStatus }): React.ReactNode {
  if (status === "failed") {
    return <CircleAlert className="size-3.5 shrink-0 text-destructive" />;
  }
  if (status === "embedded") {
    return <FileText className="size-3.5 shrink-0 text-primary" />;
  }
  return <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />;
}

export function DocumentChips({
  chips,
  onRetry,
  onRemove,
}: {
  chips: DocChip[];
  onRetry: (id: string) => void;
  onRemove: (id: string) => void;
}): React.ReactNode {
  if (chips.length === 0) return null;

  return (
    <div className="mb-2 flex flex-wrap gap-2">
      {chips.map((chip) => (
        <div
          key={chip.id}
          className="flex max-w-full items-center gap-2 rounded-md border border-border bg-card px-2 py-1 text-xs"
          title={chip.failureReason ?? chip.filename}
        >
          <StatusIcon status={chip.status} />
          <span className="truncate font-medium">{chip.filename}</span>
          <span className="shrink-0 text-muted-foreground">
            {chip.status === "uploading" && chip.percentage !== undefined
              ? `${chip.percentage}%`
              : STATUS_LABEL[chip.status]}
          </span>
          {chip.status === "failed" && (
            <button
              type="button"
              aria-label="Retry"
              onClick={() => onRetry(chip.id)}
              className="shrink-0 text-muted-foreground hover:text-foreground"
            >
              <RefreshCw className="size-3.5" />
            </button>
          )}
          <button
            type="button"
            aria-label="Remove"
            onClick={() => onRemove(chip.id)}
            className="shrink-0 text-muted-foreground hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
