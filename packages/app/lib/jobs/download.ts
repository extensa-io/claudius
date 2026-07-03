/**
 * Client-side download of a research report as a Markdown file. The report text
 * is already in the browser (on the job view or the message), so no round trip
 * is needed — we build a Blob and click a temporary link.
 */

/** A filesystem-safe slug from the question, for the download filename. */
function slugify(question: string): string {
  const slug = question
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "report";
}

export function downloadReportMarkdown(question: string, report: string): void {
  if (!report) return;
  const heading = `# Research report\n\n**Question:** ${question}\n\n`;
  const blob = new Blob([heading + report], {
    type: "text/markdown;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `research-${slugify(question)}.md`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
