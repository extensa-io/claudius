"use client";

import { Globe } from "lucide-react";
import { useState } from "react";
import type { SearchActivityDataPart } from "@/lib/chat/types";
import { cn } from "@/lib/utils";

/**
 * The compact activity strip under an assistant turn (memory, web search).
 *
 * The design used to render each of these as a full-width card, which is
 * informative but crowds the transcript once a conversation gets long. Now each
 * is a quiet icon chip: a one-line summary on hover (the native `title`
 * tooltip), and the full detail expanded inline on click. The icon-only resting
 * state keeps the transcript clean; the detail is one interaction away.
 */

/**
 * A single activity icon. `label` is an optional short suffix shown next to the
 * icon (e.g. the search backend "brave"); `summary` is the hover tooltip;
 * `accent` tints the chip (memory uses the primary/purple accent to preserve its
 * identity). Clicking toggles the `children` detail panel below the strip.
 */
export function IconChip({
  icon,
  label,
  summary,
  accent = false,
  expandable = true,
  open,
  onToggle,
}: {
  icon: React.ReactNode;
  label?: string;
  summary: string;
  accent?: boolean;
  expandable?: boolean;
  open: boolean;
  onToggle: () => void;
}): React.ReactNode {
  return (
    <button
      type="button"
      onClick={expandable ? onToggle : undefined}
      title={summary}
      aria-label={summary}
      aria-expanded={expandable ? open : undefined}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-1 text-xs transition-colors",
        accent
          ? "border-primary/30 bg-primary/5 text-primary hover:bg-primary/10"
          : "border-border bg-muted/40 text-muted-foreground hover:text-foreground",
        expandable ? "cursor-pointer" : "cursor-default",
        open && (accent ? "bg-primary/10" : "text-foreground"),
      )}
    >
      {icon}
      {label ? <span className="font-medium">{label}</span> : null}
    </button>
  );
}

/**
 * The web-search activity icon: a globe plus the backend that served the query
 * (Brave by default, Tavily on fallback/high-value). Hover shows the query and
 * source count; clicking expands the human-readable line (the source links
 * themselves stay in the live tool-activity card, which still renders while the
 * search runs).
 */
export function SearchActivityChip({
  search,
}: {
  search: SearchActivityDataPart;
}): React.ReactNode {
  const [open, setOpen] = useState(false);
  const backend = search.source === "brave" ? "Brave" : "Tavily";
  const count = `${search.resultCount} ${search.resultCount === 1 ? "source" : "sources"}`;
  const summary = search.query
    ? `Searched via ${backend} for “${search.query}” · ${count}`
    : `Searched via ${backend} · ${count}`;

  return (
    <div className="inline-block">
      <IconChip
        icon={<Globe className="size-3.5" />}
        label={search.source}
        summary={summary}
        open={open}
        onToggle={() => setOpen((v) => !v)}
      />
      {open && (
        <p className="mt-1 pl-1 text-xs text-muted-foreground">{summary}</p>
      )}
    </div>
  );
}
