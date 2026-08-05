"use client";

import { GitBranch, Globe, Link as LinkIcon } from "lucide-react";
import { useState } from "react";
import type {
  SearchActivityDataPart,
  UrlReadActivityDataPart,
} from "@/lib/chat/types";
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

/** Shorten a URL to "host + first path segment" for a compact chip label. */
function shortUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const host = u.hostname.replace(/^www\./, "");
    const seg = u.pathname.split("/").filter(Boolean)[0];
    return seg ? `${host}/${seg}` : host;
  } catch {
    return raw;
  }
}

/**
 * The read_url activity icon (Phase 11): a GitHub mark for a repo read, a link
 * icon for a generic page. Hover shows the URL and outcome; clicking expands the
 * line. The fetched content stays in the live tool-activity card while the read
 * runs — this chip is the settled, resting representation.
 */
export function UrlReadActivityChip({
  read,
}: {
  read: UrlReadActivityDataPart;
}): React.ReactNode {
  const [open, setOpen] = useState(false);
  const label = shortUrl(read.url);
  const verb = read.kind === "github" ? "Read the repository" : "Read the page";
  const summary = read.ok
    ? `${verb} ${read.url}`
    : `Couldn't read ${read.url}`;

  return (
    <div className="inline-block">
      <IconChip
        icon={
          read.kind === "github" ? (
            <GitBranch className="size-3.5" />
          ) : (
            <LinkIcon className="size-3.5" />
          )
        }
        label={label}
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
