"use client";

import { Download, Loader2, Telescope, X } from "lucide-react";
import type { JobView } from "@/lib/jobs/view";
import { Markdown } from "./markdown";

/** A filesystem-safe slug from the question, for the download filename. */
function slugify(question: string): string {
  const slug = question
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "report";
}

/** Download the report as a Markdown file, entirely client-side (the report
 * text is already on the job view; no round trip needed). */
function downloadReport(job: JobView): void {
  if (!job.report) return;
  const heading = `# Research report\n\n**Question:** ${job.question ?? ""}\n\n`;
  const blob = new Blob([heading + job.report], {
    type: "text/markdown;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `research-${slugify(job.question ?? "report")}.md`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * A research job as it appears in the conversation: a titled card that shows live
 * progress while the worker runs (the steps it polls in), a cancel control, and
 * the finished report rendered as Markdown with its inline [n] citations. This is
 * the in-chat surface for work happening off on the worker.
 */
export function ResearchCard({
  job,
  onCancel,
}: {
  job: JobView;
  onCancel: (jobId: string) => void;
}): React.ReactNode {
  const active = job.status === "queued" || job.status === "running";
  const latest = job.progress.at(-1);

  return (
    <div className="my-4 rounded-lg border border-border bg-card">
      <div className="flex items-start gap-2 border-b border-border px-4 py-3">
        <Telescope className="mt-0.5 size-4 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-muted-foreground">Deep research</p>
          <p className="truncate text-sm font-medium">{job.question}</p>
        </div>
        {active && (
          <button
            type="button"
            onClick={() => onCancel(job.id)}
            aria-label="Cancel research"
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        )}
        {job.status === "done" && job.report && (
          <button
            type="button"
            onClick={() => downloadReport(job)}
            aria-label="Download report"
            title="Download report as Markdown"
            className="flex items-center gap-1.5 rounded-md px-2 h-7 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Download className="size-3.5" />
            Download
          </button>
        )}
      </div>

      <div className="px-4 py-3">
        {active && (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              <span>{latest ? latest.detail : "Starting research…"}</span>
            </div>
            {job.progress.length > 1 && (
              <ol className="space-y-0.5 pl-6 text-xs text-muted-foreground/80">
                {job.progress.slice(-5, -1).map((p, i) => (
                  <li key={i} className="truncate">
                    {p.detail}
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}

        {job.status === "done" && job.report && (
          <div className="text-sm">
            <Markdown>{job.report}</Markdown>
          </div>
        )}

        {job.status === "failed" && (
          <p className="text-sm text-destructive">
            {job.error ?? "Research failed."}
          </p>
        )}

        {job.status === "cancelled" && (
          <p className="text-sm text-muted-foreground">Research cancelled.</p>
        )}
      </div>
    </div>
  );
}
