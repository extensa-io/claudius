"use client";

import type { DynamicToolUIPart } from "ai";
import { ChevronDown, FileText, Globe, Loader2 } from "lucide-react";
import { useState } from "react";
import type {
  RetrieveToolOutput,
  WebSearchToolOutput,
} from "@/lib/chat/view-types";
import { cn } from "@/lib/utils";

/**
 * Renders the agent's tool activity inline in the thread. While a tool runs the
 * user sees a live indicator with the query; once it returns, that collapses
 * into a quiet, expandable list of what the tool found. Making every tool call
 * visible and inspectable is a deliberate product choice — for web search it is
 * the sources, for document retrieval it is the exact excerpts the answer drew
 * from, with their document and location.
 */
export function ToolActivity({
  part,
  suppressCompletedWebSearch = false,
}: {
  part: DynamicToolUIPart;
  /**
   * When the turn carries a `data-search` activity icon (new turns), the settled
   * web-search card is redundant, so it collapses and the icon in the strip is
   * the resting representation. Old turns (no data part) keep the full card.
   * The live "Searching…" indicator always shows regardless.
   */
  suppressCompletedWebSearch?: boolean;
}): React.ReactNode {
  if (part.toolName === "retrieve_documents") {
    return <RetrieveActivity part={part} />;
  }
  return (
    <WebSearchActivity
      part={part}
      suppressCompleted={suppressCompletedWebSearch}
    />
  );
}

function queryOf(part: DynamicToolUIPart): string {
  return typeof part.input === "object" && part.input !== null
    ? String((part.input as { query?: unknown }).query ?? "")
    : "";
}

function isWebSearchOutput(value: unknown): value is WebSearchToolOutput {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { results?: unknown }).results)
  );
}

function WebSearchActivity({
  part,
  suppressCompleted = false,
}: {
  part: DynamicToolUIPart;
  suppressCompleted?: boolean;
}): React.ReactNode {
  const [open, setOpen] = useState(false);
  const query = queryOf(part);

  if (part.state === "input-streaming" || part.state === "input-available") {
    return (
      <div className="my-2 flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" />
        <span>
          Searching the web{query ? ` for “${query}”` : ""}
          <span className="ml-0.5 animate-pulse">…</span>
        </span>
      </div>
    );
  }

  if (part.state === "output-error") {
    return (
      <div className="my-2 flex items-center gap-2 text-sm text-destructive">
        <Globe className="size-3.5" />
        Web search failed.
      </div>
    );
  }

  if (part.state !== "output-available") return null;

  // New turns show the settled result as an icon in the activity strip (driven
  // by the data-search part), so the full card here would duplicate it.
  if (suppressCompleted) return null;

  const results = isWebSearchOutput(part.output) ? part.output.results : [];

  return (
    <div className="my-2 rounded-lg border border-border bg-muted/40 text-sm">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-muted-foreground hover:text-foreground"
      >
        <Globe className="size-3.5 shrink-0" />
        <span className="flex-1">
          Searched the web
          {query ? ` for “${query}”` : ""} · {results.length}{" "}
          {results.length === 1 ? "source" : "sources"}
        </span>
        <ChevronDown
          className={cn(
            "size-4 shrink-0 transition-transform",
            open && "rotate-180",
          )}
        />
      </button>
      {open && results.length > 0 && (
        <ul className="space-y-2 border-t border-border px-3 py-2">
          {results.map((r, i) => (
            <li key={`${r.url}-${i}`} className="text-sm">
              <a
                href={r.url}
                target="_blank"
                rel="noreferrer"
                className="font-medium text-primary hover:underline"
              >
                {r.title || r.url}
              </a>
              <p className="line-clamp-2 text-xs text-muted-foreground">
                {r.snippet}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function isRetrieveOutput(value: unknown): value is RetrieveToolOutput {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { results?: unknown }).results)
  );
}

function RetrieveActivity({
  part,
}: {
  part: DynamicToolUIPart;
}): React.ReactNode {
  const [open, setOpen] = useState(false);
  const query = queryOf(part);

  if (part.state === "input-streaming" || part.state === "input-available") {
    return (
      <div className="my-2 flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" />
        <span>
          Reading your documents{query ? ` for “${query}”` : ""}
          <span className="ml-0.5 animate-pulse">…</span>
        </span>
      </div>
    );
  }

  if (part.state === "output-error") {
    return (
      <div className="my-2 flex items-center gap-2 text-sm text-destructive">
        <FileText className="size-3.5" />
        Document search failed.
      </div>
    );
  }

  if (part.state !== "output-available") return null;

  const results = isRetrieveOutput(part.output) ? part.output.results : [];

  return (
    <div className="my-2 rounded-lg border border-border bg-muted/40 text-sm">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-muted-foreground hover:text-foreground"
      >
        <FileText className="size-3.5 shrink-0" />
        <span className="flex-1">
          Read your documents · {results.length}{" "}
          {results.length === 1 ? "excerpt" : "excerpts"}
        </span>
        <ChevronDown
          className={cn(
            "size-4 shrink-0 transition-transform",
            open && "rotate-180",
          )}
        />
      </button>
      {open && results.length > 0 && (
        <ul className="space-y-2 border-t border-border px-3 py-2">
          {results.map((r, i) => (
            <li key={i} className="text-sm">
              <p className="font-medium text-foreground">
                {r.documentName}
                {r.location ? (
                  <span className="text-muted-foreground"> · {r.location}</span>
                ) : null}
              </p>
              <p className="line-clamp-3 text-xs text-muted-foreground">
                {r.text}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
