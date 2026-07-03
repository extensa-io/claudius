"use client";

import { Download, Sparkles, Telescope } from "lucide-react";
import { useState } from "react";
import { downloadReportMarkdown } from "@/lib/jobs/download";

/**
 * The header on a finished research report message: a label, a Download button,
 * and a Refine action. Refine reveals a one-line instruction; submitting it
 * starts a follow-up research run seeded with THIS report (see /api/research),
 * which appends an updated report — the original stays as a prior version.
 * Refine only appears when we know the report's job id (needed to seed the run).
 */
export function ReportControls({
  question,
  report,
  jobId,
  onRefine,
}: {
  question: string;
  report: string;
  jobId: string | undefined;
  onRefine: (jobId: string, instruction: string) => void;
}): React.ReactNode {
  const [open, setOpen] = useState(false);
  const [instruction, setInstruction] = useState("");

  const submit = (): void => {
    const text = instruction.trim();
    if (!text || !jobId) return;
    onRefine(jobId, text);
    setInstruction("");
    setOpen(false);
  };

  return (
    <div className="mb-2 border-b border-border pb-2">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Telescope className="size-3.5 text-primary" />
          Research report
        </span>
        <div className="flex items-center gap-1">
          {jobId && (
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-label="Refine report"
              title="Refine: run a follow-up that builds on this report"
              className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <Sparkles className="size-3.5" />
              Refine
            </button>
          )}
          <button
            type="button"
            onClick={() => downloadReportMarkdown(question, report)}
            aria-label="Download report"
            title="Download report as Markdown"
            className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Download className="size-3.5" />
            Download
          </button>
        </div>
      </div>

      {open && jobId && (
        <div className="mt-2 flex items-center gap-2">
          <input
            autoFocus
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              } else if (e.key === "Escape") {
                setOpen(false);
              }
            }}
            placeholder="How should this report change? e.g. add 2025 data, go deeper on X"
            className="flex-1 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs focus:border-ring focus:outline-none"
          />
          <button
            type="button"
            onClick={submit}
            disabled={!instruction.trim()}
            className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-40"
          >
            Refine
          </button>
        </div>
      )}
    </div>
  );
}
