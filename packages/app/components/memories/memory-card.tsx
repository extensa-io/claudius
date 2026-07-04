"use client";

import type { MemoryView, SupersededRef } from "@claudius/shared";
import { CornerDownRight, Pencil, Trash2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { cn, timeAgo } from "@/lib/utils";

/** "Jun 10" — a quiet short date for the source-conversation line. */
function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

const CATEGORY_LABEL: Record<MemoryView["category"], string> = {
  fact: "Fact",
  preference: "Preference",
  context: "Context",
};

/**
 * Importance is a 0..1 float the model sets and the user adjusts. We present it
 * as three bands (Phase 6) so editing is a click, not a slider guess: Minor,
 * Normal, Defining map to representative values, and the float lands in whichever
 * band contains it. Defining rows are the ones the always-on profile draws from.
 */
const IMPORTANCE_BANDS = [
  { label: "Minor", value: 0.2, max: 0.34 },
  { label: "Normal", value: 0.5, max: 0.67 },
  { label: "Defining", value: 0.9, max: 1.01 },
] as const;

function bandIndex(importance: number): number {
  return IMPORTANCE_BANDS.findIndex((b) => importance < b.max);
}

function CategoryPill({
  category,
}: {
  category: MemoryView["category"];
}): React.ReactNode {
  return (
    <span className="rounded-full border border-border bg-secondary px-2 py-0.5 text-[0.7rem] font-medium text-secondary-foreground">
      {CATEGORY_LABEL[category]}
    </span>
  );
}

function SourceLink({ memory }: { memory: MemoryView }): React.ReactNode {
  if (!memory.sourceConversationTitle) {
    return (
      <span>added {shortDate(memory.createdAt)}</span>
    );
  }
  return (
    <span>
      learned in{" "}
      <Link
        href={`/chat?c=${memory.sourceConversationId}`}
        className="underline decoration-dotted underline-offset-2 hover:text-foreground"
      >
        &lsquo;{memory.sourceConversationTitle}&rsquo;
      </Link>{" "}
      on {shortDate(memory.createdAt)}
    </span>
  );
}

/**
 * One memory card. Content is the headline; a category pill, source link, and
 * relative timestamps sit beneath. Edit is inline (re-embeds on save); the
 * supersession pill expands the full chain of what this memory replaced. Actions
 * reveal on hover and on keyboard focus so they aren't hidden behind a menu.
 */
export function MemoryCard({
  memory,
  onEdit,
  onDelete,
  onSetImportance,
  fetchChain,
}: {
  memory: MemoryView;
  onEdit: (id: string, content: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onSetImportance: (id: string, importance: number) => Promise<void>;
  fetchChain: (id: string) => Promise<SupersededRef[]>;
}): React.ReactNode {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(memory.content);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [chain, setChain] = useState<SupersededRef[] | null>(null);

  const hasHistory = memory.supersedes.length > 0;
  const activeBand = bandIndex(memory.importance);

  const save = async (): Promise<void> => {
    const next = draft.trim();
    if (next.length < 3 || next === memory.content) {
      setEditing(false);
      setDraft(memory.content);
      return;
    }
    setBusy(true);
    try {
      await onEdit(memory.id, next);
      setEditing(false);
    } finally {
      setBusy(false);
    }
  };

  const toggleExpand = async (): Promise<void> => {
    const next = !expanded;
    setExpanded(next);
    if (next && chain === null) {
      setChain(await fetchChain(memory.id));
    }
  };

  return (
    <div className="group rounded-lg border border-border bg-card px-4 py-3 focus-within:border-primary/40 hover:border-primary/40">
      {editing ? (
        <div className="flex flex-col gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={2}
            className="w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary/50"
            autoFocus
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void save()}
              disabled={busy}
              className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground disabled:opacity-50"
            >
              Save
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setDraft(memory.content);
              }}
              className="rounded-md px-3 py-1 text-xs text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="flex items-start justify-between gap-3">
          <p className="text-[0.95rem] leading-6 text-foreground">
            {memory.content}
          </p>
          <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
            <button
              type="button"
              aria-label="Edit memory"
              onClick={() => setEditing(true)}
              className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <Pencil className="size-3.5" />
            </button>
            <button
              type="button"
              aria-label="Delete memory"
              onClick={() => void onDelete(memory.id)}
              className="rounded p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            >
              <Trash2 className="size-3.5" />
            </button>
          </div>
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <CategoryPill category={memory.category} />
        <SourceLink memory={memory} />
        <span aria-hidden>·</span>
        <span>last used {timeAgo(memory.lastAccessedAt)}</span>
      </div>

      <div className="mt-2 flex items-center gap-2">
        <span className="text-[0.7rem] uppercase tracking-wide text-muted-foreground/70">
          Importance
        </span>
        <div className="inline-flex overflow-hidden rounded-md border border-border">
          {IMPORTANCE_BANDS.map((band, i) => {
            const active = i === activeBand;
            return (
              <button
                key={band.label}
                type="button"
                disabled={active}
                onClick={() => void onSetImportance(memory.id, band.value)}
                className={cn(
                  "px-2 py-0.5 text-[0.7rem] transition-colors",
                  active
                    ? "bg-primary/15 font-medium text-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground",
                  i > 0 && "border-l border-border",
                )}
                title={
                  band.label === "Defining"
                    ? "Defining memories are always available as your profile"
                    : undefined
                }
              >
                {band.label}
              </button>
            );
          })}
        </div>
      </div>

      {hasHistory && (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => void toggleExpand()}
            className="flex items-center gap-1 text-xs text-primary hover:underline"
          >
            <CornerDownRight className="size-3" />
            {memory.supersedes.some((s) => s.reason === "merge")
              ? "consolidated from earlier memories"
              : "replaced an earlier memory"}
          </button>
          {expanded && (
            <ul className="mt-2 space-y-1.5 border-l border-border pl-3">
              {(chain ?? memory.supersedes).map((old) => (
                <li key={old.id} className="text-xs text-muted-foreground">
                  <span className="line-through decoration-muted-foreground/50">
                    {old.content}
                  </span>
                  <span className={cn("mt-0.5 block text-[0.7rem] opacity-80")}>
                    {old.reason === "merge" ? "merged in" : "replaced"}{" "}
                    {timeAgo(old.replacedAt)}
                    {old.sourceConversationTitle
                      ? ` · from ‘${old.sourceConversationTitle}’`
                      : ""}
                  </span>
                </li>
              ))}
              {chain !== null && chain.length === 0 && (
                <li className="text-xs text-muted-foreground">
                  No earlier versions.
                </li>
              )}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
